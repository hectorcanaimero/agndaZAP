import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessHour, Service } from '@prisma/client';
import type Redis from 'ioredis';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';

/** Tope duro del bloque cacheable (clínica + horario + servicios + profesionales). */
const MAX_CHARS = 2000;

/** `weekday` de `BusinessHour`: 0=domingo … 6=sábado (ver schema.prisma). */
const WEEKDAY_NAMES: Record<number, string> = {
  0: 'Domingo',
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
};

/** Orden de despliegue lunes→domingo (no el orden numérico del campo `weekday`). */
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

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

  private formatMinutes(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  /**
   * Agrupa días consecutivos (lunes→domingo) con el mismo rango horario:
   * "Lunes a viernes 8:00 a 17:00. Sábado 9:00 a 13:00.". Días sin filas se
   * omiten (cerrado), no se listan como "cerrado" explícitamente. Soporta
   * turnos partidos (varias filas el mismo día → "9:00 a 13:00 y 15:00 a 18:00").
   */
  private buildScheduleLine(rows: BusinessHour[]): string {
    if (rows.length === 0) return 'Horario: no informado';

    const byWeekday = new Map<
      number,
      Array<{ startMinutes: number; endMinutes: number }>
    >();
    for (const row of rows) {
      const list = byWeekday.get(row.weekday) ?? [];
      list.push({ startMinutes: row.startMinutes, endMinutes: row.endMinutes });
      byWeekday.set(row.weekday, list);
    }

    const rangeFor = (weekday: number): string | null => {
      const list = byWeekday.get(weekday);
      if (!list || list.length === 0) return null;
      return [...list]
        .sort((a, b) => a.startMinutes - b.startMinutes)
        .map(
          (r) =>
            `${this.formatMinutes(r.startMinutes)} a ${this.formatMinutes(r.endMinutes)}`,
        )
        .join(' y ');
    };

    const groups: Array<{ days: number[]; range: string; lastIndex: number }> =
      [];
    WEEKDAY_DISPLAY_ORDER.forEach((weekday, index) => {
      const range = rangeFor(weekday);
      if (range === null) return; // día cerrado: NO extiende el grupo anterior
      const last = groups[groups.length - 1];
      // Sólo fusiona si el día es CONSECUTIVO al último del grupo (mismo
      // rango Y sin un día cerrado en el medio) — evita que "lunes 9-13,
      // martes cerrado, miércoles 9-13" salga como "lunes a miércoles".
      if (last && last.range === range && last.lastIndex === index - 1) {
        last.days.push(weekday);
        last.lastIndex = index;
      } else {
        groups.push({ days: [weekday], range, lastIndex: index });
      }
    });

    if (groups.length === 0) return 'Horario: no informado';

    const parts = groups.map((g) => {
      // Estilo español: sólo el primer día del tramo va con mayúscula
      // ("Lunes a viernes"), el segundo va en minúscula salvo que sea el
      // único día del grupo ("Sábado 9:00 a 13:00.").
      const label =
        g.days.length === 1
          ? WEEKDAY_NAMES[g.days[0]]
          : `${WEEKDAY_NAMES[g.days[0]]} a ${WEEKDAY_NAMES[g.days[g.days.length - 1]].toLowerCase()}`;
      return `${label} ${g.range}.`;
    });

    return `Horario de atención: ${parts.join(' ')}`;
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
