import { Injectable, Logger } from '@nestjs/common';
import { Appointment, Patient, Service } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Genera calendars iCal (RFC 5545) para que los profesionales suscriban su
 * agenda desde iOS/Android/Google Calendar.
 *
 * Auth: HMAC token derivado del `professionalId` con `ICAL_SECRET`. La URL
 * queda como `.../professionals/:id/ical?token=X` — pública pero no
 * enumerable (necesitás conocer el id + secreto server). Revocable regenerando
 * `ICAL_SECRET` (rota TODAS las suscripciones — usar solo en incidents).
 *
 * NO real-time — los clientes hacen refresh cada 15min–1h. Read-only.
 */
@Injectable()
export class IcalService {
  private readonly logger = new Logger(IcalService.name);
  // Ventana de citas incluidas: 30 días hacia atrás + 90 hacia adelante. Las
  // citas viejas no interesan; las muy lejanas rara vez existen y engordan
  // el feed.
  private static readonly PAST_DAYS = 30;
  private static readonly FUTURE_DAYS = 90;

  constructor(private readonly prisma: PrismaService) {}

  /** Secreto para firmar tokens. Fail-fast en producción si no está seteado. */
  private secret(): string {
    const s = process.env.ICAL_SECRET;
    if (!s) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ICAL_SECRET no configurado en producción');
      }
      // Dev-only default — permite trabajar sin setear la env explícitamente.
      return 'dev-ical-secret';
    }
    return s;
  }

  /** Firma el `professionalId` — hex de 32 chars (SHA-256 truncado). */
  tokenFor(professionalId: string): string {
    return createHmac('sha256', this.secret())
      .update(professionalId)
      .digest('hex')
      .slice(0, 32);
  }

  /** Compara token con timingSafeEqual para evitar timing attacks. */
  verifyToken(professionalId: string, token: string | undefined): boolean {
    if (!token) return false;
    const expected = this.tokenFor(professionalId);
    if (expected.length !== token.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
    } catch {
      return false;
    }
  }

  /**
   * Devuelve un `.ics` con las citas activas del profesional.
   * Filtra CANCELADA y NO_SHOW — no queremos ensuciar el calendar del profesional
   * con turnos que ya no aplican. ATENDIDA se mantiene por historial.
   */
  async buildFeed(professionalId: string): Promise<string> {
    const prof = await this.prisma.professional.findUnique({
      where: { id: professionalId },
      include: { clinic: { select: { name: true, timezone: true } } },
    });
    if (!prof) {
      // No filtramos con clinicId acá porque el token ya prueba conocimiento
      // del ID. Si el profesional fue borrado, devolvemos un feed vacío válido.
      return this.emptyFeed('AgendaZap');
    }

    const now = DateTime.now();
    const from = now.minus({ days: IcalService.PAST_DAYS }).toJSDate();
    const to = now.plus({ days: IcalService.FUTURE_DAYS }).toJSDate();

    const appts = await this.prisma.appointment.findMany({
      where: {
        professionalId,
        status: { notIn: ['CANCELADA', 'NO_SHOW'] },
        startAt: { gte: from, lte: to },
      },
      include: {
        patient: { select: { name: true, phone: true } },
        service: { select: { name: true } },
      },
      orderBy: { startAt: 'asc' },
    });

    return this.serialize(prof.clinic.name, prof.name, appts);
  }

  /* ─────────────────────── ICS serialization ─────────────────────── */

  private serialize(
    clinicName: string,
    professionalName: string,
    appts: Array<
      Appointment & {
        patient: Pick<Patient, 'name' | 'phone'>;
        service: Pick<Service, 'name'>;
      }
    >,
  ): string {
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AgendaZap//iCal Feed//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${this.escape(`${clinicName} · ${professionalName}`)}`,
      `X-WR-TIMEZONE:UTC`,
    ];

    for (const a of appts) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:appt-${a.id}@agendazap`,
        `DTSTAMP:${this.formatUtc(a.updatedAt)}`,
        `DTSTART:${this.formatUtc(a.startAt)}`,
        `DTEND:${this.formatUtc(a.endAt)}`,
        `SUMMARY:${this.escape(this.summaryFor(a))}`,
        `DESCRIPTION:${this.escape(this.descriptionFor(a))}`,
        `STATUS:${this.mapStatus(a.status)}`,
        'END:VEVENT',
      );
    }

    lines.push('END:VCALENDAR');
    // RFC 5545 exige CRLF entre líneas.
    return lines.join('\r\n') + '\r\n';
  }

  private summaryFor(a: {
    patient: { name: string | null };
    service: { name: string };
  }): string {
    // Patient.name puede ser null si el paciente todavía no fue nombrado.
    return `${a.patient.name ?? 'Paciente'} · ${a.service.name}`;
  }

  private descriptionFor(a: {
    patient: { name: string | null; phone: string };
    service: { name: string };
    notes: string | null;
    status: string;
  }): string {
    const parts = [
      `Paciente: ${a.patient.name ?? '(sin nombre)'}`,
      `Tel: ${a.patient.phone}`,
      `Servicio: ${a.service.name}`,
      `Estado: ${a.status}`,
    ];
    if (a.notes) parts.push(`Notas: ${a.notes}`);
    return parts.join('\\n');
  }

  private mapStatus(status: string): string {
    // RFC 5545: TENTATIVE | CONFIRMED | CANCELLED
    switch (status) {
      case 'CONFIRMADA':
      case 'ATENDIDA':
        return 'CONFIRMED';
      case 'PENDIENTE':
      case 'EN_RIESGO':
        return 'TENTATIVE';
      default:
        return 'CONFIRMED';
    }
  }

  /** ICS timestamps en UTC: YYYYMMDDTHHMMSSZ (sin separadores). */
  private formatUtc(d: Date): string {
    return DateTime.fromJSDate(d)
      .toUTC()
      .toFormat("yyyyLLdd'T'HHmmss'Z'");
  }

  /** RFC 5545: escapar `,`, `;`, `\` y newlines en TEXT properties. */
  private escape(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  private emptyFeed(name: string): string {
    return (
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//AgendaZap//iCal Feed//ES',
        'CALSCALE:GREGORIAN',
        `X-WR-CALNAME:${this.escape(name)}`,
        'END:VCALENDAR',
      ].join('\r\n') + '\r\n'
    );
  }
}
