import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Appointment,
  AppointmentSource as PrismaAppointmentSource,
  AppointmentStatus,
  Prisma,
} from '@prisma/client';
import { DateTime } from 'luxon';
import {
  assertReschedulable,
  RESCHEDULABLE_STATUSES,
} from '../appointments/appointment-status.util';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService } from './availability.service';

// Re-export para que el resto del backend consuma el mismo type que la DB.
// BOT_WEB representa el flujo "bot mandó link web y el paciente completó allá".
export type AppointmentSource = PrismaAppointmentSource;

export interface CreateAppointmentInput {
  clinicId: string;
  patient: { phone: string; name?: string; consent?: boolean };
  serviceId: string;
  professionalId: string;
  /** ISO en la TZ de la clínica (o con offset explícito). */
  startAtISO: string;
  notes?: string;
  source: AppointmentSource;
  /**
   * Conversation de WhatsApp de origen. Se guarda cuando `source === 'BOT_WEB'`
   * para atar la cita al chat (permite notificar cambios de estado por WA sin
   * volver a resolver el chat a partir del phone). Ignorado si source es BOT o
   * PUBLIC — en BOT no lo necesitamos (la conversación ya se ata via patient
   * en el FSM), en PUBLIC no existe conversación.
   */
  conversationId?: string;
}

/**
 * Lógica reutilizable de creación de citas. Consumida por el bot (FSM) y el
 * endpoint público (/agendar/[clinicSlug]). Encapsula:
 *  - validación multi-tenant estricta (todo cruzado por clinicId),
 *  - re-verificación de que el slot sigue siendo válido justo antes de crear,
 *  - upsert idempotente del Patient por (clinicId, phone),
 *  - manejo del conflicto @@unique([professionalId, startAt]) → 409,
 *  - idempotencia extra para el bot (evitar dos citas si se confunde),
 *  - programación de recordatorios en el mismo flujo.
 */
@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly reminders: RemindersService,
  ) {}

  /**
   * Estados desde los que el paciente puede cancelar o mover su cita.
   *
   * Es la MISMA lista que usa el panel (`RESCHEDULABLE_STATUSES`), reusada y no
   * copiada: dos fuentes de verdad para la misma regla significan que renombrar
   * un estado en el schema rompe una en compilación y deja la otra en silencio,
   * con el resultado de que nadie podría cancelar y nada fallaría.
   *
   * Lo que el paciente tiene DE MÁS respecto al panel es el corte temporal
   * (`startAt > now`), que vive en `isPatientMutable`.
   */
  static readonly PATIENT_MUTABLE_STATUSES = RESCHEDULABLE_STATUSES;

  /**
   * ¿El paciente puede todavía cancelar/mover esta cita? Regla única para que
   * el `canCancel`/`canReschedule` que ve la web y la validación del servidor
   * no puedan divergir.
   */
  static isPatientMutable(
    appt: Pick<Appointment, 'status' | 'startAt'>,
    now: Date = new Date(),
  ): boolean {
    return (
      SchedulingService.PATIENT_MUTABLE_STATUSES.includes(appt.status) &&
      appt.startAt.getTime() > now.getTime()
    );
  }

  async createAppointment(
    input: CreateAppointmentInput,
  ): Promise<{ appointment: Appointment; patientCreated: boolean }> {
    const {
      clinicId,
      patient,
      serviceId,
      professionalId,
      startAtISO,
      notes,
      source,
      conversationId,
    } = input;

    // 1) Cargamos clínica + servicio + profesional filtrando SIEMPRE por clinicId.
    // Cualquier findUnique por id atómico se re-valida contra clinicId para cortar
    // fugas entre tenants (por ej. si el bot recibiese un id de otra clínica).
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
    });
    if (!clinic) throw new NotFoundException('clínica no encontrada');

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, clinicId, active: true },
    });
    if (!service) {
      throw new NotFoundException('servicio no encontrado en esta clínica');
    }

    const professional = await this.prisma.professional.findFirst({
      where: { id: professionalId, clinicId, active: true },
      include: { services: { where: { id: serviceId }, select: { id: true } } },
    });
    if (!professional) {
      throw new NotFoundException('profesional no encontrado en esta clínica');
    }
    if (professional.services.length === 0) {
      throw new BadRequestException(
        'el profesional no atiende este servicio',
      );
    }

    // 2) Parseamos startAt en la TZ de la clínica y calculamos endAt con Luxon.
    // Nunca usamos `new Date(iso)` naïve — respetamos la zona de la clínica.
    const zone = clinic.timezone;
    const startDT = DateTime.fromISO(startAtISO, { zone });
    if (!startDT.isValid) {
      throw new BadRequestException('startAtISO inválido');
    }
    const endDT = startDT.plus({ minutes: service.durationMin });

    if (startDT <= DateTime.now().setZone(zone)) {
      throw new BadRequestException('no se pueden agendar horarios pasados');
    }

    // 3) Re-verificamos con AvailabilityService que el slot sigue vivo.
    // Rango pequeño (1 día) alrededor del inicio para minimizar cómputo.
    const slots = await this.availability.getSlots({
      clinicId,
      serviceId,
      professionalId,
      fromISO: startDT.startOf('day').toISO() ?? startAtISO,
      days: 1,
      limit: 200,
    });
    const startMs = startDT.toMillis();
    const stillFree = slots.some((s) => s.startAt.getTime() === startMs);
    if (!stillFree) {
      // Puede ser porque cae fuera de horario, en TimeOff o porque otro reservó.
      throw new ConflictException('slot ya no está disponible');
    }

    // 4) ¿Ya existe el paciente? Lo leemos para dos cosas:
    //  - la idempotencia del bot (abajo),
    //  - `patientCreated`, que informa al caller si el `Patient` nació en ESTA
    //    llamada. Lo consume el bot para decidir si puede ligar la Conversation
    //    al Patient: ligar a un paciente preexistente dejaría que un chat `@lid`
    //    acabara viendo las citas de otra persona con el mismo teléfono.
    const existingPatient = await this.prisma.patient.findUnique({
      where: { clinicId_phone: { clinicId, phone: patient.phone } },
      select: { id: true },
    });

    // Idempotencia del bot: si el paciente ya tiene una cita futura activa
    // para este servicio, la devolvemos en vez de crear duplicado. Regla solo
    // para BOT — el endpoint público es explícito y no debería auto-deduplicar.
    if (source === 'BOT' && existingPatient) {
      const existingAppt = await this.prisma.appointment.findFirst({
        where: {
          clinicId,
          patientId: existingPatient.id,
          serviceId,
          status: { in: ['PENDIENTE', 'CONFIRMADA', 'EN_RIESGO'] },
          startAt: { gte: DateTime.now().toJSDate() },
        },
        orderBy: { startAt: 'asc' },
      });
      if (existingAppt) {
        // OJO si algún día esta dedupe se extiende a `PUBLIC`/`BOT_WEB`:
        // `public.controller.ts` emite un `manageUrl` sobre lo que devuelva
        // este método. Devolver una cita preexistente a un caller público
        // significaría entregarle a cualquiera que escriba el teléfono de otra
        // persona un link de gestión sobre LA CITA DE ESA PERSONA. Hoy no pasa
        // porque el endpoint público solo usa PUBLIC y BOT_WEB.
        return { appointment: existingAppt, patientCreated: false };
      }
    }

    // 5) Alta o actualización del paciente por (clinicId, phone). Consent solo
    // se prende: no pisamos un true previo. Si el nombre viene y no había, lo
    // guardamos.
    //
    // No usamos `upsert` porque necesitamos saber con certeza si insertamos:
    // un upsert no lo distingue, y deducirlo del `findUnique` de arriba sería
    // mentira bajo concurrencia (dos requests del mismo teléfono a la vez
    // reportarían ambas `patientCreated: true`). Con `create` + captura del
    // P2002 el dato es exacto: solo una de las dos gana el INSERT.
    const patientUpdate = {
      ...(patient.name ? { name: patient.name } : {}),
      ...(patient.consent === true ? { consent: true } : {}),
    };
    let patientRow: { id: string };
    let patientCreated = false;
    if (existingPatient) {
      patientRow = await this.prisma.patient.update({
        where: { clinicId_phone: { clinicId, phone: patient.phone } },
        data: patientUpdate,
        select: { id: true },
      });
    } else {
      try {
        patientRow = await this.prisma.patient.create({
          data: {
            clinicId,
            phone: patient.phone,
            name: patient.name ?? null,
            consent: patient.consent ?? false,
          },
          select: { id: true },
        });
        patientCreated = true;
      } catch (e) {
        // Comprobamos también QUÉ constraint saltó: si mañana `Patient` gana
        // otro único (email, documento), un P2002 de ese otro mandaría a un
        // `update` por `clinicId_phone` que no encontraría fila y moriría con
        // P2025, enmascarando el error real.
        const target = (e as Prisma.PrismaClientKnownRequestError)?.meta
          ?.target;
        const isPhoneConflict =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          (target === undefined ||
            String(target).includes('phone'));
        if (!isPhoneConflict) {
          throw e;
        }
        // Carrera: otra request creó el paciente entre el findUnique y este
        // insert. No lo creamos nosotros → `patientCreated` se queda en false.
        patientRow = await this.prisma.patient.update({
          where: { clinicId_phone: { clinicId, phone: patient.phone } },
          data: patientUpdate,
          select: { id: true },
        });
      }
    }

    const initialStatus = clinic.autoConfirm ? 'CONFIRMADA' : 'PENDIENTE';

    // 6) Creamos la cita en una transacción. El @@unique([professionalId, startAt])
    // es la última línea de defensa: si dos requests corren a la vez, uno gana y
    // el otro recibe P2002 → devolvemos 409 claro.
    let appointment: Appointment;
    try {
      appointment = await this.prisma.$transaction(async (tx) => {
        return tx.appointment.create({
          data: {
            clinicId,
            patientId: patientRow.id,
            serviceId,
            professionalId,
            startAt: startDT.toJSDate(),
            endAt: endDT.toJSDate(),
            status: initialStatus,
            notes: notes ?? null,
            confirmedAt:
              initialStatus === 'CONFIRMADA' ? DateTime.now().toJSDate() : null,
            source,
            // Solo persistimos conversationId cuando source === BOT_WEB.
            // Silenciosamente lo ignoramos en otros casos para evitar FK
            // spurios si un caller lo pasa por accidente.
            conversationId:
              source === 'BOT_WEB' && conversationId ? conversationId : null,
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('slot ya tomado');
      }
      throw e;
    }

    // 7) Programamos recordatorios. Si la programación falla, no rollbackeamos
    // la cita — es preferible tener cita sin recordatorios que perderla; el
    // reminders.service loguea el error y podemos reintentar manualmente.
    try {
      await this.reminders.scheduleForAppointment(appointment.id);
    } catch (e) {
      this.logger.error(
        `No se pudieron programar recordatorios para ${appointment.id}: ${e}`,
      );
    }

    return { appointment, patientCreated };
  }

  /**
   * Cancelación iniciada por el paciente desde el link de gestión (ADR 0020).
   *
   * Separada de la cancelación del panel a propósito: acá no hay usuario
   * autenticado, la autorización la da el token, y por eso el estado se
   * re-valida contra la DB en vez de confiar en lo que la web haya mostrado —
   * entre que se pintó la página y se pulsó el botón, la clínica pudo marcar
   * la cita como ATENDIDA o el horario pudo pasar.
   *
   * Idempotente: si la cita ya estaba CANCELADA devuelve la fila tal cual, sin
   * tocar recordatorios ni `canceledAt`. Un doble click no es un error.
   *
   * @throws NotFoundException si la cita no existe o no es de esta clínica.
   * @throws ConflictException si el estado ya no permite cancelar.
   */
  async cancelByPatient(input: {
    clinicId: string;
    appointmentId: string;
  }): Promise<Appointment> {
    const { clinicId, appointmentId } = input;

    // La condición va DENTRO del UPDATE, no en un `findFirst` previo: entre la
    // lectura y la escritura la recepcionista puede marcar la cita ATENDIDA
    // desde el panel, y un update incondicional la pisaría. Eso dejaría una
    // transición ATENDIDA → CANCELADA que `ALLOWED_TRANSITIONS` declara
    // imposible, con el `outcome` colgando y el no-show rate contaminado.
    const { count } = await this.prisma.appointment.updateMany({
      where: {
        id: appointmentId,
        clinicId,
        status: { in: [...SchedulingService.PATIENT_MUTABLE_STATUSES] },
        startAt: { gt: new Date() },
      },
      data: { status: 'CANCELADA', canceledAt: new Date() },
    });

    if (count === 0) {
      // No se canceló: hay que distinguir por qué. Esta lectura ya no es una
      // carrera — la escritura no ocurrió.
      const appt = await this.prisma.appointment.findFirst({
        where: { id: appointmentId, clinicId },
      });
      if (!appt) throw new NotFoundException('cita no encontrada');
      // Doble click o reintento: ya estaba cancelada. No es un error.
      if (appt.status === 'CANCELADA') return appt;
      throw new ConflictException('esta cita ya no se puede cancelar');
    }

    const updated = await this.prisma.appointment.findFirstOrThrow({
      where: { id: appointmentId, clinicId },
    });

    // Los recordatorios de una cita cancelada solo pueden hacer daño: el
    // paciente recibiría un "confirma tu cita" de algo que ya canceló.
    // Fail-open igual que en el alta: la cancelación ya está persistida y es
    // lo que importa; un recordatorio huérfano se detecta por el log.
    try {
      await this.reminders.cancelForAppointment(appointmentId);
    } catch (e) {
      this.logger.error(
        `No se pudieron cancelar recordatorios de ${appointmentId}: ${e}`,
      );
    }

    this.logger.log(`appointment canceled by patient apptId=${appointmentId}`);
    return updated;
  }

  /**
   * Reagenda una cita existente moviéndola a un nuevo `startAtISO`. NO cambia
   * el paciente, servicio ni profesional (para eso: cancelar + crear nueva).
   *
   * Validaciones:
   *  - Multi-tenant estricto por `clinicId`.
   *  - Status debe permitir reagendamiento (ver `assertReschedulable` en el
   *    controller — este método asume que ya se validó, pero re-verifica que
   *    el appointment exista + esté en la clínica correcta).
   *  - Nuevo `startAt` debe ser futuro y coincidir con un slot disponible
   *    del mismo profesional/servicio (usa `AvailabilityService`).
   *
   * Comportamiento:
   *  - Si el nuevo `startAtISO` coincide con el `startAt` actual (mismo instante),
   *    es NO-OP idempotente — retorna la cita sin tocar reminders. Evita ruido
   *    al hacer "save" sin cambios reales.
   *  - Reprograma reminders (cancela viejos + agenda nuevos con el nuevo horario).
   *
   * Errores:
   *  - `NotFoundException` si la cita no existe o no es de esta clínica.
   *  - `BadRequestException` si startAtISO es inválido o pasado.
   *  - `ConflictException` si el slot no está disponible (fuera de BH, TimeOff,
   *    ya tomado por otra cita, etc.) o si el `@@unique([professionalId, startAt])`
   *    explota en la carrera.
   */
  async rescheduleAppointment(input: {
    clinicId: string;
    appointmentId: string;
    startAtISO: string;
    /**
     * `true` cuando el movimiento lo inicia el paciente desde el link de
     * gestión. Solo esos cuentan para su tope: los que hace recepción desde el
     * panel no deben gastarle el cupo al paciente.
     */
    byPatient?: boolean;
    /**
     * Tope de movimientos del paciente. Se comprueba DENTRO del update
     * condicional, no antes: leer el contador y escribir después deja una
     * ventana por la que una ráfaga con el mismo token pasa el check varias
     * veces.
     */
    maxPatientReschedules?: number;
  }): Promise<Appointment> {
    const {
      clinicId,
      appointmentId,
      startAtISO,
      byPatient = false,
      maxPatientReschedules,
    } = input;

    // 1) Cargar cita + service + clinic (todo cross-checked por clinicId).
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      include: { service: true, clinic: true },
    });
    if (!appt) throw new NotFoundException('cita no encontrada');

    // Desde S6 reagendar MUTA el estado (vuelve a PENDIENTE), así que el
    // servicio ya no puede confiar en que el caller validó: un caller nuevo
    // resucitaría una cita ATENDIDA o NO_SHOW y falsearía el histórico.
    assertReschedulable(appt.status);

    const zone = appt.clinic.timezone;
    const newStartDT = DateTime.fromISO(startAtISO, { zone });
    if (!newStartDT.isValid) {
      throw new BadRequestException('startAtISO inválido');
    }

    // 2) No-op: mismo instante. Idempotencia — no tocamos DB ni reminders.
    if (newStartDT.toMillis() === appt.startAt.getTime()) {
      return appt;
    }

    if (newStartDT <= DateTime.now().setZone(zone)) {
      throw new BadRequestException('no se puede reagendar al pasado');
    }

    const newEndDT = newStartDT.plus({ minutes: appt.service.durationMin });

    // 3) Validar disponibilidad. AvailabilityService excluye a esta cita del
    // cálculo porque su startAt actual sigue en DB — para eso pasamos
    // `excludeAppointmentId` (implementado abajo en getSlots). Si no se soporta
    // el parámetro (versión previa), el @@unique constraint de abajo actúa como
    // última red de seguridad.
    const slots = await this.availability.getSlots({
      clinicId,
      serviceId: appt.serviceId,
      professionalId: appt.professionalId,
      fromISO: newStartDT.startOf('day').toISO() ?? startAtISO,
      days: 1,
      limit: 200,
      excludeAppointmentId: appointmentId,
    });
    const startMs = newStartDT.toMillis();
    const stillFree = slots.some((s) => s.startAt.getTime() === startMs);
    if (!stillFree) {
      throw new ConflictException('slot no disponible');
    }

    // 4) Update de la cita. El @@unique([professionalId, startAt]) es la última
    // línea de defensa contra doble reserva concurrente → traducimos a 409.
    //
    // La cita vuelve SIEMPRE a PENDIENTE y se limpia `confirmedAt`: una
    // confirmación es para un horario concreto, y dejarla puesta significaría
    // que la clínica cuenta como confirmada una cita que el paciente no ha
    // vuelto a mirar. La confirmación se vuelve a ganar con el recordatorio del
    // horario nuevo, que se reprograma abajo junto al check-risk.
    //
    // Esto hace que reagendar saque la cita de EN_RIESGO, y es deliberado: la
    // señal del "reagendador reincidente" no va por estado —lo perderíamos en
    // cada movimiento— sino por `rescheduleCount`, que solo sube.
    let updated: Appointment;
    try {
      // El tope del paciente va en el `where` del update, no en un `if` previo:
      // con el check fuera, dos requests concurrentes con el mismo token pasan
      // ambas. `updateMany` + `count` es la forma de hacerlo atómico.
      if (byPatient && typeof maxPatientReschedules === 'number') {
        const { count } = await this.prisma.appointment.updateMany({
          where: {
            id: appointmentId,
            clinicId,
            patientRescheduleCount: { lt: maxPatientReschedules },
          },
          data: {
            startAt: newStartDT.toJSDate(),
            endAt: newEndDT.toJSDate(),
            rescheduleCount: { increment: 1 },
            patientRescheduleCount: { increment: 1 },
            lastRescheduledAt: DateTime.now().toJSDate(),
          },
        });
        if (count === 0) {
          throw new ConflictException('tope de reagendamientos alcanzado');
        }
        updated = await this.prisma.appointment.findFirstOrThrow({
          where: { id: appointmentId, clinicId },
        });
      } else {
        updated = await this.prisma.appointment.update({
          where: { id: appointmentId },
          data: {
            startAt: newStartDT.toJSDate(),
            endAt: newEndDT.toJSDate(),
            rescheduleCount: { increment: 1 },
            lastRescheduledAt: DateTime.now().toJSDate(),
          },
        });
      }
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('slot ya tomado');
      }
      throw e;
    }

    // 5) Reprogramar reminders + check-risk. `scheduleForAppointment` es
    // idempotente (cancela los previos primero). Fail-open: si falla, la cita
    // queda reagendada y logueamos — preferimos cita sin recordatorios a
    // rollback silencioso.
    //
    // 6) Reinicio del ciclo de confirmación, SOLO si quedó alguna vía de
    // recuperarla. Una confirmación vale para un horario concreto, así que al
    // mover la cita deja de valer… pero si el horario nuevo está tan cerca que
    // no cabe ningún recordatorio ni el check-risk, degradar a PENDIENTE dejaría
    // la cita desconfirmada PARA SIEMPRE y en silencio: el caso típico es
    // recepción moviendo una cita de hoy a dos horas más tarde, que es
    // justamente cuando el paciente acaba de confirmar por teléfono.
    //
    // Con vía de recuperación → PENDIENTE y el paciente reconfirma con el
    // recordatorio nuevo. Sin ella → se conserva el estado, que es la
    // información más fiel: nadie ha dejado de confirmar nada.
    //
    // `confirmedAt` NO se borra, y la distinción es deliberada:
    //   - `status` responde "¿está confirmada AHORA?" → PENDIENTE hasta que
    //     el paciente responda al recordatorio del horario nuevo.
    //   - `confirmedAt` responde "¿llegó a confirmar alguna vez?" → es un hecho
    //     histórico y alimenta la tasa de confirmación del dashboard, que mide
    //     si los recordatorios funcionan.
    // Borrarlo reescribía métricas de días ya cerrados: el numerador perdía la
    // confirmación mientras el denominador (recordatorios SENT) se quedaba,
    // así que la tasa bajaba sola y el trend de 14 días cambiaba hacia atrás.
    // Una reconfirmación posterior lo sobreescribe con la fecha nueva.
    try {
      const { remindersScheduled, riskScheduled } =
        await this.reminders.scheduleForAppointment(appointmentId);

      const hasRecoveryPath = remindersScheduled > 0 || riskScheduled;
      if (hasRecoveryPath && updated.status !== 'PENDIENTE') {
        updated = await this.prisma.appointment.update({
          where: { id: appointmentId },
          data: { status: 'PENDIENTE' },
        });
      } else if (!hasRecoveryPath) {
        this.logger.log(
          `reschedule ${appointmentId}: sin recordatorios posibles en el horario nuevo — se conserva status=${updated.status}`,
        );
      }
    } catch (e) {
      // Si la reprogramación falló tampoco tocamos el estado: desconfirmar sin
      // haber podido armar un recordatorio es el peor de los dos mundos.
      this.logger.error(
        `No se pudieron reprogramar recordatorios para ${appointmentId}: ${e}`,
      );
    }

    return updated;
  }
}
