import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessHour, Service } from '@prisma/client';
import type Redis from 'ioredis';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { formatSchedule } from '../common/business-hours.util';

/** Tope duro del bloque cacheable (clínica + horario + servicios + profesionales). */
const MAX_CHARS = 2000;

/** `weekday` de `BusinessHour`: 0=domingo … 6=sábado (ver schema.prisma). */
const APPOINTMENT_STATUS_WORDS: Record<string, string> = {
  PENDIENTE: 'pendiente de confirmación',
  CONFIRMADA: 'confirmada',
  EN_RIESGO: 'en riesgo, sin confirmar',
};

type ClinicFactsInput = {
  name: string;
  address: string | null;
  publicWhatsappPhone: string | null;
  currency: string;
  timezone: string;
  locale: string;
};

type ProfessionalWithServices = {
  name: string;
  specialty: string | null;
  services: Array<{ name: string }>;
};

/**
 * ClinicFactsService — arma el bloque "FUENTE BD" que `KnowledgeService.answer`
 * agrega al prompt del RAG: datos reales de la clínica (horario, servicios,
 * profesionales, y si hay `phone`, la próxima cita de ESE número) en texto
 * plano, sin embeddings. Ver ADR 0019.
 *
 * **Nunca inventa precios ni horarios**: si `Service.priceCents` es null,
 * "precio a consultar"; si no hay `BusinessHour`, "Horario: no informado".
 *
 * **Multi-tenant estricto**: toda query lleva `clinicId`. La cita del
 * paciente sólo sale si `phone` matchea un `Patient` de esa MISMA clínica —
 * nunca se expone nombre ni otro dato del paciente, sólo la cita.
 *
 * **Cache**: la parte sin paciente (nombre, horario, servicios,
 * profesionales) se cachea 60 s en Redis por `clinicId` — es la misma para
 * cualquier paciente que pregunte. La línea de "próxima cita" NUNCA se
 * cachea (es por-paciente) y se recalcula en cada llamada.
 */
@Injectable()
export class ClinicFactsService {
  private readonly logger = new Logger(ClinicFactsService.name);
  static readonly TTL_SEC = 60;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  static cacheKey(clinicId: string): string {
    return `clinic:facts:${clinicId}`;
  }

  /**
   * Arma el bloque de hechos de la clínica. Vacío (`''`) si la clínica no
   * existe (no debería pasar en uso normal: el caller ya la resolvió antes).
   */
  async build(clinicId: string, phone?: string | null): Promise<string> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: {
        name: true,
        address: true,
        publicWhatsappPhone: true,
        currency: true,
        timezone: true,
        locale: true,
      },
    });
    if (!clinic) return '';

    const base = await this.getBaseBlock(clinicId, clinic);

    if (!phone) return base;

    const appointmentLine = await this.buildAppointmentLine(
      clinicId,
      phone,
      clinic,
    );
    return appointmentLine ? `${base}\n${appointmentLine}` : base;
  }

  // ─────────────────────── Bloque base (cacheado) ───────────────────────

  private async getBaseBlock(
    clinicId: string,
    clinic: ClinicFactsInput,
  ): Promise<string> {
    const key = ClinicFactsService.cacheKey(clinicId);
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return cached;
    } catch (e) {
      this.logger.warn(
        `clinic facts cache GET falló (redis), calculo de DB: ${(e as Error).message}`,
      );
    }

    const block = await this.computeBaseBlock(clinicId, clinic);

    try {
      await this.redis.set(key, block, 'EX', ClinicFactsService.TTL_SEC);
    } catch (e) {
      this.logger.warn(
        `clinic facts cache SET falló (redis): ${(e as Error).message}`,
      );
    }

    return block;
  }

  private async computeBaseBlock(
    clinicId: string,
    clinic: ClinicFactsInput,
  ): Promise<string> {
    const [businessHours, services, professionals] = await Promise.all([
      this.prisma.businessHour.findMany({
        where: { clinicId, professionalId: null },
        orderBy: [{ weekday: 'asc' }, { startMinutes: 'asc' }],
      }),
      this.prisma.service.findMany({
        where: { clinicId, active: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.professional.findMany({
        where: { clinicId, active: true },
        select: {
          name: true,
          specialty: true,
          services: {
            where: { active: true },
            select: { name: true },
            orderBy: { name: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    // Recorta profesionales/servicios (el más largo primero) hasta entrar en
    // el tope de caracteres. Nunca recorta por debajo de 1 ítem visible.
    let maxServices = services.length;
    let maxProfessionals = professionals.length;
    let block = this.assembleBaseBlock(
      clinic,
      businessHours,
      services,
      professionals,
      maxServices,
      maxProfessionals,
    );
    while (
      block.length > MAX_CHARS &&
      (maxServices > 1 || maxProfessionals > 1)
    ) {
      if (maxServices >= maxProfessionals && maxServices > 1) {
        maxServices -= 1;
      } else if (maxProfessionals > 1) {
        maxProfessionals -= 1;
      } else {
        break;
      }
      block = this.assembleBaseBlock(
        clinic,
        businessHours,
        services,
        professionals,
        maxServices,
        maxProfessionals,
      );
    }
    return block;
  }

  private assembleBaseBlock(
    clinic: ClinicFactsInput,
    businessHours: BusinessHour[],
    services: Service[],
    professionals: ProfessionalWithServices[],
    maxServices: number,
    maxProfessionals: number,
  ): string {
    const lines: string[] = [`Clínica: ${clinic.name}`];
    if (clinic.address) lines.push(`Dirección: ${clinic.address}`);
    if (clinic.publicWhatsappPhone) {
      lines.push(`WhatsApp: ${clinic.publicWhatsappPhone}`);
    }
    lines.push(this.buildScheduleLine(businessHours));
    lines.push(
      this.buildServicesSection(services, clinic.currency, maxServices),
    );
    lines.push(this.buildProfessionalsSection(professionals, maxProfessionals));
    return lines.join('\n');
  }

  // ─────────────────────────── Horario ───────────────────────────

  /**
   * Línea de horario para el bloque de hechos. El formateo vive en
   * `common/business-hours.util.ts`, compartido con el mensaje de handoff del
   * bot: dos redacciones distintas del mismo horario en la misma conversación
   * serían peor que no darlo.
   */
  private buildScheduleLine(rows: BusinessHour[]): string {
    const schedule = formatSchedule(rows);
    return schedule ? `Horario de atención: ${schedule}` : 'Horario: no informado';
  }

  // ─────────────────────────── Servicios ───────────────────────────

  /** Nunca inventa un precio: si `priceCents` es null, "precio a consultar". */
  private formatPrice(priceCents: number | null, currency: string): string {
    if (priceCents === null) return 'precio a consultar';
    return `${currency} ${(priceCents / 100).toFixed(2)}`;
  }

  private buildServicesSection(
    services: Service[],
    currency: string,
    maxCount: number,
  ): string {
    if (services.length === 0) return 'Servicios: no hay servicios activos.';
    const shown = services.slice(0, maxCount);
    const lines = shown.map(
      (s) =>
        `- ${s.name} (${s.durationMin} min) - ${this.formatPrice(s.priceCents, currency)}`,
    );
    const remaining = services.length - shown.length;
    if (remaining > 0) lines.push(`…y ${remaining} más.`);
    return `Servicios:\n${lines.join('\n')}`;
  }

  // ─────────────────────────── Profesionales ───────────────────────────

  private buildProfessionalsSection(
    professionals: ProfessionalWithServices[],
    maxCount: number,
  ): string {
    if (professionals.length === 0) {
      return 'Profesionales: no hay profesionales activos.';
    }
    const shown = professionals.slice(0, maxCount);
    const lines = shown.map((p) => {
      const specialty = p.specialty ? ` (${p.specialty})` : '';
      const services =
        p.services.length > 0
          ? p.services.map((s) => s.name).join(', ')
          : 'sin servicios asignados';
      return `- ${p.name}${specialty}: atiende ${services}.`;
    });
    const remaining = professionals.length - shown.length;
    if (remaining > 0) lines.push(`…y ${remaining} más.`);
    return `Profesionales:\n${lines.join('\n')}`;
  }

  // ─────────────────────────── Próxima cita (por paciente) ───────────────────────────

  /**
   * Sólo la próxima cita ACTIVA (pendiente/en riesgo/confirmada) del
   * `phone` dado en ESA clínica. Nunca el nombre del paciente ni otro dato
   * — sólo servicio, profesional, fecha y estado de la cita.
   */
  private async buildAppointmentLine(
    clinicId: string,
    phone: string,
    clinic: Pick<ClinicFactsInput, 'timezone' | 'locale'>,
  ): Promise<string | null> {
    const patient = await this.prisma.patient.findUnique({
      where: { clinicId_phone: { clinicId, phone } },
    });
    if (!patient) return null;

    const appt = await this.prisma.appointment.findFirst({
      where: {
        clinicId,
        patientId: patient.id,
        status: { in: ['PENDIENTE', 'EN_RIESGO', 'CONFIRMADA'] },
        startAt: { gte: DateTime.now().toJSDate() },
      },
      orderBy: { startAt: 'asc' },
      include: { service: true, professional: true },
    });
    if (!appt) return null;

    const when = DateTime.fromJSDate(appt.startAt, { zone: clinic.timezone })
      .setLocale(clinic.locale)
      .toFormat("cccc d 'de' LLLL 'a las' HH:mm");
    const statusWord = APPOINTMENT_STATUS_WORDS[appt.status] ?? appt.status.toLowerCase();

    return `Próxima cita de este número: ${appt.service.name} con ${appt.professional.name} el ${when} (${statusWord}).`;
  }
}
