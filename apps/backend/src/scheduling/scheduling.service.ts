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
  Prisma,
} from '@prisma/client';
import { DateTime } from 'luxon';
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
   * `ATENDIDA`, `CANCELADA` y `NO_SHOW` son terminales: ya pasó algo con esa
   * cita y cambiarla falsearía el histórico.
   */
  static readonly PATIENT_MUTABLE_STATUSES = [
    'PENDIENTE',
    'CONFIRMADA',
    'EN_RIESGO',
  ] as const;

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
      (SchedulingService.PATIENT_MUTABLE_STATUSES as readonly string[]).includes(
        appt.status,
      ) && appt.startAt.getTime() > now.getTime()
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
        if (
          !(
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === 'P2002'
          )
        ) {
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

    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
    });
    if (!appt) throw new NotFoundException('cita no encontrada');

    if (appt.status === 'CANCELADA') return appt;

    if (!SchedulingService.isPatientMutable(appt)) {
      throw new ConflictException('esta cita ya no se puede cancelar');
    }

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'CANCELADA', canceledAt: new Date() },
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
  }): Promise<Appointment> {
    const { clinicId, appointmentId, startAtISO } = input;

    // 1) Cargar cita + service + clinic (todo cross-checked por clinicId).
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      include: { service: true, clinic: true },
    });
    if (!appt) throw new NotFoundException('cita no encontrada');

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
    let updated: Appointment;
    try {
      updated = await this.prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          startAt: newStartDT.toJSDate(),
          endAt: newEndDT.toJSDate(),
        },
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

    // 5) Reprogramar reminders. `scheduleForAppointment` es idempotente (cancela
    // los previos primero). Fail-open: si falla, la cita queda reagendada y
    // logueamos — preferimos cita sin recordatorios a rollback silencioso.
    try {
      await this.reminders.scheduleForAppointment(appointmentId);
    } catch (e) {
      this.logger.error(
        `No se pudieron reprogramar recordatorios para ${appointmentId}: ${e}`,
      );
    }

    return updated;
  }
}
