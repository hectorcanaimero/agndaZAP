import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AvailabilityService, Slot } from '../scheduling/availability.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { CreatePublicAppointmentDto } from './dto/create-public-appointment.dto';
import { RateLimit } from './rate-limit.guard';
import { SlugValidationPipe } from './slug.pipe';

/**
 * PublicController — Bloque 3 del roadmap.
 *
 * Endpoints públicos (SIN auth) para la página `/agendar/[clinicSlug]`:
 * - `GET /api/public/clinics/:slug`               → snapshot de la clínica.
 * - `GET /api/public/clinics/:slug/availability`  → slots.
 * - `POST /api/public/clinics/:slug/appointments` → crea la cita.
 *
 * Reglas de seguridad:
 * - Multi-tenant estricto: todo se resuelve por slug → clinicId. `SchedulingService`
 *   re-valida service/professional dentro de la clínica.
 * - Rate-limit por IP+slug (5/min POST, 30/min GET).
 * - Honeypot anti-bot: si viene con valor, respondemos 200 sin crear nada.
 * - Cero PII en logs. Sólo IP + slug + status.
 *
 * `@Public()` a nivel controller: opt-out del `JwtAuthGuard` global. Sin esto
 * el guard exigiría Bearer token y rompería el flujo público.
 */
@Public()
@Controller('public/clinics')
export class PublicController {
  private readonly logger = new Logger('PublicController');

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly scheduling: SchedulingService,
  ) {}

  /**
   * Devuelve el snapshot público de la clínica: servicios y profesionales activos
   * con la relación entre ambos (para que el frontend filtre `professionalId` por
   * el `serviceId` elegido).
   *
   * NO exponemos: teléfonos, emails, config interna (wahaSession, autoConfirm),
   * usuarios, ni datos de otras clínicas. Solo lo estrictamente necesario para
   * el form.
   */
  @Get(':slug')
  @UseGuards(RateLimit(30))
  async getClinic(@Param('slug', SlugValidationPipe) slug: string): Promise<{
    id: string;
    name: string;
    slug: string;
    address: string | null;
    timezone: string;
    locale: string;
    services: Array<{
      id: string;
      name: string;
      durationMin: number;
      priceCents: number | null;
    }>;
    professionals: Array<{ id: string; name: string; serviceIds: string[] }>;
  }> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { slug },
      include: {
        services: {
          where: { active: true },
          select: {
            id: true,
            name: true,
            durationMin: true,
            priceCents: true,
          },
          orderBy: { name: 'asc' },
        },
        professionals: {
          where: { active: true },
          include: {
            services: { where: { active: true }, select: { id: true } },
          },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!clinic) {
      // 404 explícito, sin leak de si la clínica existe pero está inactiva.
      throw new NotFoundException('clínica no encontrada');
    }

    return {
      id: clinic.id,
      name: clinic.name,
      slug: clinic.slug,
      address: clinic.address,
      timezone: clinic.timezone,
      locale: clinic.locale,
      services: clinic.services,
      professionals: clinic.professionals.map((p) => ({
        id: p.id,
        name: p.name,
        serviceIds: p.services.map((s) => s.id),
      })),
    };
  }

  /**
   * Proxy público a AvailabilityService. Resolvemos `clinicId` por slug y
   * dejamos que el motor haga el resto (respetando TZ + business hours + timeoff
   * + citas ocupadas).
   *
   * Parámetros:
   * - `serviceId` (obligatorio)
   * - `professionalId` (obligatorio)
   * - `from` (ISO 8601, obligatorio) — típicamente el inicio del día "hoy"
   *   en TZ de la clínica.
   * - `days` (default 7).
   */
  @Get(':slug/availability')
  @UseGuards(RateLimit(30))
  async getAvailability(
    @Param('slug', SlugValidationPipe) slug: string,
    @Query('serviceId') serviceId: string,
    @Query('professionalId') professionalId: string,
    @Query('from') from: string,
    @Query('days') days?: string,
  ): Promise<Slot[]> {
    if (!serviceId || !professionalId || !from) {
      throw new BadRequestException(
        'serviceId, professionalId y from son obligatorios',
      );
    }

    const clinic = await this.prisma.clinic.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!clinic) {
      throw new NotFoundException('clínica no encontrada');
    }

    const parsedDays = days ? Math.max(1, Math.min(30, Number(days))) : 7;

    return this.availability.getSlots({
      clinicId: clinic.id,
      serviceId,
      professionalId,
      fromISO: from,
      days: parsedDays,
      limit: 50,
    });
  }

  /**
   * Crea la cita desde la página pública.
   *
   * Delega en `SchedulingService.createAppointment` que:
   * - Valida multi-tenant (service + professional pertenecen a la clínica).
   * - Re-verifica que el slot sigue libre.
   * - Maneja el conflicto atómico contra `@@unique([professionalId, startAt])`.
   * - Upsertea el paciente por (clinicId, phone).
   * - Programa recordatorios.
   *
   * Si el honeypot viene con valor, respondemos 200 (no 400) SIN crear la cita.
   * Motivo: no queremos señalizarle al bot que detectamos la trampa; si diera
   * 400 aprendería a dejar el campo vacío.
   */
  @Post(':slug/appointments')
  @UseGuards(RateLimit(5))
  @HttpCode(201)
  async createAppointment(
    @Param('slug', SlugValidationPipe) slug: string,
    @Body() dto: CreatePublicAppointmentDto,
  ): Promise<
    | {
        id: string;
        startAt: Date;
        endAt: Date;
        status: string;
      }
    | { ok: true }
  > {
    // 1) Honeypot: bot detectado. Respondemos 200 para no revelar la trampa.
    // NO logueamos el phone/name; sólo el slug.
    if (dto.honeypot && dto.honeypot.length > 0) {
      this.logger.warn(`honeypot triggered slug=${slug}`);
      return { ok: true };
    }

    // 2) Resolvemos clínica por slug.
    const clinic = await this.prisma.clinic.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!clinic) {
      throw new NotFoundException('clínica no encontrada');
    }

    // 3) Normalizamos phone: agregamos `+` si no lo trae (E.164 estricto).
    const normalizedPhone = dto.phone.startsWith('+')
      ? dto.phone
      : `+${dto.phone}`;

    // 4) Delegamos. SchedulingService tira ConflictException / NotFoundException
    // / BadRequestException con sus mensajes internos; el endpoint público
    // reemplaza el 409 por un texto orientado a paciente ("elegí otro").
    let appointment;
    try {
      appointment = await this.scheduling.createAppointment({
        clinicId: clinic.id,
        patient: {
          phone: normalizedPhone,
          name: dto.name,
          consent: true, // ya validamos consent=true en el DTO.
        },
        serviceId: dto.serviceId,
        professionalId: dto.professionalId,
        startAtISO: dto.startAtISO,
        notes: dto.notes,
        source: 'PUBLIC',
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        // Mensaje orientado al usuario final del form público.
        throw new ConflictException(
          'El horario elegido ya no está disponible. Elegí otro.',
        );
      }
      throw e;
    }

    // 5) Log de éxito sin PII.
    this.logger.log(
      `appointment created slug=${slug} apptId=${appointment.id} status=${appointment.status}`,
    );

    // Cero PII en la respuesta: NO devolvemos `patient.{name,phone}`. El frontend
    // ya tiene el nombre en su state; no hace falta reflejarlo. Esto minimiza
    // superficie de exposición en logs de red / caches / etc.
    return {
      id: appointment.id,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      status: appointment.status,
    };
  }
}
