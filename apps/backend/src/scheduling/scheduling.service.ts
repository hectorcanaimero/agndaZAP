import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Appointment, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService } from './availability.service';

export type AppointmentSource = 'BOT' | 'PUBLIC';

export interface CreateAppointmentInput {
  clinicId: string;
  patient: { phone: string; name?: string; consent?: boolean };
  serviceId: string;
  professionalId: string;
  /** ISO en la TZ de la clínica (o con offset explícito). */
  startAtISO: string;
  notes?: string;
  source: AppointmentSource;
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

  async createAppointment(input: CreateAppointmentInput): Promise<Appointment> {
    const {
      clinicId,
      patient,
      serviceId,
      professionalId,
      startAtISO,
      notes,
      source,
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

    // 4) Idempotencia del bot: si el paciente ya tiene una cita futura activa
    // para este servicio, la devolvemos en vez de crear duplicado. Regla solo
    // para BOT — el endpoint público es explícito y no debería auto-deduplicar.
    if (source === 'BOT') {
      const existingPatient = await this.prisma.patient.findUnique({
        where: { clinicId_phone: { clinicId, phone: patient.phone } },
      });
      if (existingPatient) {
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
        if (existingAppt) return existingAppt;
      }
    }

    // 5) Upsert del paciente por (clinicId, phone). Consent solo se prende: no
    // pisamos un true previo. Si el nombre viene y no había, lo guardamos.
    const patientRow = await this.prisma.patient.upsert({
      where: { clinicId_phone: { clinicId, phone: patient.phone } },
      create: {
        clinicId,
        phone: patient.phone,
        name: patient.name ?? null,
        consent: patient.consent ?? false,
      },
      update: {
        ...(patient.name ? { name: patient.name } : {}),
        ...(patient.consent === true ? { consent: true } : {}),
      },
    });

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

    return appointment;
  }
}
