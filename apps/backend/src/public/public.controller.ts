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
import { DateTime } from 'luxon';
import { AvailabilityService, Slot } from '../scheduling/availability.service';
import { SchedulingSessionService } from '../scheduling/scheduling-session.service';
import {
  AppointmentSource,
  SchedulingService,
} from '../scheduling/scheduling.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { CreatePublicAppointmentDto } from './dto/create-public-appointment.dto';
import { RescheduleByTokenDto } from './dto/reschedule-by-token.dto';
import { RateLimit } from './rate-limit.guard';
import { SlugValidationPipe } from './slug.pipe';
import { normalizeE164 } from '../common/phone.util';

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
    private readonly sessions: SchedulingSessionService,
  ) {}

  private parseAvailabilityDays(days?: string): number {
    if (!days) return 7;

    const parsed = Number(days);
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException('days debe ser un entero');
    }

    return Math.max(1, Math.min(30, parsed));
  }

  private assertValidAvailabilityFrom(from: string): void {
    const parsed = DateTime.fromISO(from);
    if (!parsed.isValid) {
      throw new BadRequestException('from debe ser una fecha ISO 8601 válida');
    }
  }

  private async assertBookableSelection(input: {
    clinicId: string;
    serviceId: string;
    professionalId: string;
  }): Promise<void> {
    const { clinicId, serviceId, professionalId } = input;
    const [service, professional] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: serviceId, clinicId, active: true },
        select: { id: true },
      }),
      this.prisma.professional.findFirst({
        where: { id: professionalId, clinicId, active: true },
        include: {
          services: { where: { id: serviceId }, select: { id: true } },
        },
      }),
    ]);

    if (!service) {
      throw new NotFoundException('servicio no encontrado en esta clínica');
    }
    if (!professional) {
      throw new NotFoundException('profesional no encontrado en esta clínica');
    }
    if (professional.services.length === 0) {
      throw new BadRequestException('el profesional no atiende este servicio');
    }
  }

  /**
   * Devuelve el snapshot público de la clínica: servicios y profesionales activos
   * con la relación entre ambos (para que el frontend filtre `professionalId` por
   * el `serviceId` elegido).
   *
   * NO exponemos: teléfonos de profesionales/usuarios/pacientes, emails,
   * config interna (wahaSession, autoConfirm), usuarios, ni datos de otras
   * clínicas. Solo lo estrictamente necesario para el form.
   *
   * Única excepción (opt-in): `whatsappPhone` = `Clinic.publicWhatsappPhone`,
   * el número de WhatsApp de la clínica que el operador configuró en
   * /panel/ajustes para que /gracias muestre "Escribir a la clínica". Si no lo
   * configuró, devolvemos `null` — nunca inferimos uno desde la sesión WAHA.
   */
  @Get(':slug')
  @UseGuards(RateLimit(30, 'public-clinic'))
  async getClinic(@Param('slug', SlugValidationPipe) slug: string): Promise<{
    id: string;
    name: string;
    slug: string;
    address: string | null;
    timezone: string;
    locale: string;
    whatsappPhone: string | null;
    services: Array<{
      id: string;
      name: string;
      durationMin: number;
      priceCents: number | null;
    }>;
    professionals: Array<{ id: string; name: string; serviceIds: string[] }>;
  }> {
    // `findFirst` + `status: 'ACTIVE'`: una clínica SUSPENDED/ARCHIVED responde
    // 404 igual que una inexistente. `findUnique` no admite filtros extra.
    const clinic = await this.prisma.clinic.findFirst({
      where: { slug, status: 'ACTIVE' },
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
      whatsappPhone: clinic.publicWhatsappPhone ?? null,
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
  @UseGuards(RateLimit(30, 'public-availability'))
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
    this.assertValidAvailabilityFrom(from);

    const clinic = await this.prisma.clinic.findFirst({
      where: { slug, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!clinic) {
      throw new NotFoundException('clínica no encontrada');
    }

    await this.assertBookableSelection({
      clinicId: clinic.id,
      serviceId,
      professionalId,
    });

    const parsedDays = this.parseAvailabilityDays(days);

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
  @UseGuards(RateLimit(5, 'public-book'))
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
    const clinic = await this.prisma.clinic.findFirst({
      where: { slug, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!clinic) {
      throw new NotFoundException('clínica no encontrada');
    }

    // 3) Si vino token, lo consumimos AHORA (single-use). Antes de crear la
    // cita — así una race condition (doble click) no crea dos citas atadas al
    // mismo token; la segunda invocación al POST recibe token null y sigue
    // el flujo público normal (o 400 si el token era el único identificador).
    //
    // Validación cross-tenant: el token guarda `clinicSlug` propio, tiene que
    // coincidir con el `:slug` de la URL. Un token de otra clínica → 400. Esto
    // corta cualquier intento de reusar un token en el slug equivocado.
    let source: AppointmentSource = 'PUBLIC';
    let conversationId: string | undefined;
    if (dto.token) {
      const session = await this.sessions.consume(dto.token);
      if (!session) {
        throw new BadRequestException(
          'el link expiró o ya fue usado — pide uno nuevo por WhatsApp',
        );
      }
      if (session.clinicSlug !== slug) {
        // Log de seguridad: alguien intentó reusar un token en otra clínica.
        this.logger.warn(
          `token/slug mismatch tokenSlug=${session.clinicSlug} urlSlug=${slug}`,
        );
        throw new BadRequestException('link inválido para esta clínica');
      }
      source = 'BOT_WEB';
      conversationId = session.conversationId;
    }

    // 4) Normalizamos phone a E.164 con `+` (helper único, ver phone.util).
    const normalizedPhone = normalizeE164(dto.phone);
    if (!normalizedPhone) {
      throw new BadRequestException('phone inválido');
    }

    // 5) Delegamos. SchedulingService tira ConflictException / NotFoundException
    // / BadRequestException con sus mensajes internos; el endpoint público
    // reemplaza el 409 por un texto orientado a paciente ("elegí otro").
    let appointment;
    try {
      // `patientCreated` se queda acá dentro: en el borde público diría si ese
      // teléfono ya era paciente de la clínica, o sea un oráculo para enumerar
      // pacientes probando números.
      ({ appointment } = await this.scheduling.createAppointment({
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
        source,
        conversationId,
      }));
    } catch (e) {
      if (e instanceof ConflictException) {
        // Mensaje orientado al usuario final del form público.
        throw new ConflictException(
          'El horario elegido ya no está disponible. Elige otro.',
        );
      }
      throw e;
    }

    // 6) Log de éxito sin PII. Incluye source para el dashboard.
    this.logger.log(
      `appointment created slug=${slug} apptId=${appointment.id} source=${source} status=${appointment.status}`,
    );

    // Link de gestión para que /gracias ofrezca "cancelar o cambiar horario"
    // sin que el paciente tenga que escribir por WhatsApp. Fail-open: si Redis
    // está caído la cita ya está creada y eso es lo que importa — devolvemos
    // la respuesta sin `manageUrl` y el front simplemente no muestra el link.
    let manageUrl: string | undefined;
    try {
      manageUrl = await this.issueManageUrl(appointment, slug);
    } catch (e) {
      this.logger.error(
        `no se pudo emitir el manage token slug=${slug} apptId=${appointment.id}: ${(e as Error).message}`,
      );
    }

    // Cero PII en la respuesta: NO devolvemos `patient.{name,phone}`. El frontend
    // ya tiene el nombre en su state; no hace falta reflejarlo. Esto minimiza
    // superficie de exposición en logs de red / caches / etc.
    return {
      id: appointment.id,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      status: appointment.status,
      ...(manageUrl ? { manageUrl } : {}),
    };
  }

  // ──────────────────── Gestión de cita por link (ADR 0020) ────────────────────

  /**
   * Emite un token de gestión y arma la URL pública de la página de la cita.
   * `{WEB_BASE_URL}/{locale}/agendar/{slug}/cita?t={token}`.
   */
  private async issueManageUrl(
    appt: { id: string; clinicId: string; startAt: Date },
    slug: string,
  ): Promise<string> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: appt.clinicId },
      select: { locale: true },
    });
    const patient = await this.prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { patient: { select: { phone: true } } },
    });
    const { token } = await this.sessions.createManage(
      {
        appointmentId: appt.id,
        clinicId: appt.clinicId,
        clinicSlug: slug,
        phone: patient?.patient.phone ?? null,
      },
      appt.startAt,
    );
    const baseUrl = (
      process.env.WEB_BASE_URL ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return `${baseUrl}/${clinic?.locale ?? 'es'}/agendar/${slug}/cita?t=${token}`;
  }

  /**
   * Resuelve un token de gestión a su cita, validando tenant.
   *
   * Todos los fallos (token inexistente, expirado, slug que no coincide, cita
   * borrada) devuelven el MISMO 404 con el mismo mensaje. Diferenciarlos le
   * diría a quien pruebe tokens si acertó el formato o la clínica.
   */
  private async resolveManageOr404(slug: string, token: string) {
    const session = await this.sessions.resolveManage(token);
    if (!session || session.clinicSlug !== slug) {
      throw new NotFoundException(
        'este link ya no es válido — pide uno nuevo por WhatsApp',
      );
    }

    const appointment = await this.prisma.appointment.findFirst({
      // El `clinicId` del token es la barrera multi-tenant: aunque el id de la
      // cita se filtrara, sin el token de esa clínica no se resuelve.
      where: { id: session.appointmentId, clinicId: session.clinicId },
      include: {
        service: { select: { id: true, name: true, durationMin: true } },
        professional: { select: { id: true, name: true } },
        patient: { select: { name: true } },
        clinic: {
          select: { name: true, address: true, timezone: true, locale: true },
        },
      },
    });
    if (!appointment) {
      throw new NotFoundException(
        'este link ya no es válido — pide uno nuevo por WhatsApp',
      );
    }

    return { session, appointment };
  }

  /**
   * `GET /:slug/appointments/manage/:token` — datos de la cita para la página
   * de gestión. NO consume el token: el paciente puede abrir el link, mirar,
   * recargar y volver más tarde.
   *
   * Devuelve solo lo que la página necesita mostrar. Del paciente sale el
   * nombre y nada más: quien tiene el link ya sabe de quién es la cita, pero no
   * hay motivo para exponer su teléfono en una URL que puede quedar en el
   * historial del navegador o reenviada por WhatsApp.
   */
  @Get(':slug/appointments/manage/:token')
  @UseGuards(RateLimit(10, 'manage'))
  async getManagedAppointment(
    @Param('slug', SlugValidationPipe) slug: string,
    @Param('token') token: string,
  ) {
    const { appointment } = await this.resolveManageOr404(slug, token);
    const mutable = SchedulingService.isPatientMutable(appointment);

    return {
      appointment: {
        id: appointment.id,
        serviceId: appointment.service.id,
        serviceName: appointment.service.name,
        professionalId: appointment.professional.id,
        professionalName: appointment.professional.name,
        startAtISO: appointment.startAt.toISOString(),
        durationMin: appointment.service.durationMin,
        status: appointment.status,
      },
      clinic: {
        name: appointment.clinic.name,
        address: appointment.clinic.address,
        timezone: appointment.clinic.timezone,
        locale: appointment.clinic.locale,
      },
      patient: { name: appointment.patient.name },
      canCancel: mutable,
      canReschedule: mutable,
    };
  }

  /**
   * `POST /:slug/appointments/manage/:token/cancel` — el paciente cancela.
   *
   * El estado se re-valida en el servicio contra la DB: entre que se pintó la
   * página y se pulsó el botón la clínica pudo marcarla ATENDIDA. 409 en ese
   * caso, con el estado actual para que la web pueda decir qué pasó.
   */
  @Post(':slug/appointments/manage/:token/cancel')
  @UseGuards(RateLimit(10, 'manage'))
  @HttpCode(200)
  async cancelManagedAppointment(
    @Param('slug', SlugValidationPipe) slug: string,
    @Param('token') token: string,
  ): Promise<{ status: string }> {
    const { session, appointment } = await this.resolveManageOr404(slug, token);

    const updated = await this.scheduling.cancelByPatient({
      clinicId: session.clinicId,
      appointmentId: appointment.id,
    });

    // La cita ya no es gestionable: el token no tiene nada más que ofrecer.
    await this.sessions.invalidateManage(token);

    this.logger.log(
      `appointment canceled via link slug=${slug} apptId=${appointment.id}`,
    );
    return { status: updated.status };
  }

  /**
   * `POST /:slug/appointments/manage/:token/reschedule` — el paciente mueve su
   * cita a otro horario del mismo servicio y profesional.
   *
   * Mueve la cita in-place (mismo id). La alternativa —crear una nueva y
   * cancelar la vieja— dejaría una fila `CANCELADA` por cada reagendamiento, y
   * el no-show rate se calcula sobre `ATENDIDA + NO_SHOW + CANCELADA`: cada
   * paciente que reagenda en vez de faltar diluiría hacia abajo justo la
   * métrica que el producto promete mejorar. Ver ADR 0020.
   *
   * Emite un token nuevo porque el TTL va atado a `startAt`, que acaba de
   * cambiar, e invalida el anterior.
   */
  @Post(':slug/appointments/manage/:token/reschedule')
  @UseGuards(RateLimit(10, 'manage'))
  @HttpCode(200)
  async rescheduleManagedAppointment(
    @Param('slug', SlugValidationPipe) slug: string,
    @Param('token') token: string,
    @Body() dto: RescheduleByTokenDto,
  ) {
    const { session, appointment } = await this.resolveManageOr404(slug, token);

    // Misma regla que `canReschedule` del GET: el servicio de reagendamiento lo
    // comparte con el panel, donde el staff sí puede mover citas en estados que
    // al paciente le cerramos, así que el corte va acá.
    if (!SchedulingService.isPatientMutable(appointment)) {
      throw new ConflictException('esta cita ya no se puede cambiar de horario');
    }

    let updated;
    try {
      updated = await this.scheduling.rescheduleAppointment({
        clinicId: session.clinicId,
        appointmentId: appointment.id,
        startAtISO: dto.startAtISO,
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        throw new ConflictException(
          'Ese horario ya no está disponible. Elige otro.',
        );
      }
      throw e;
    }

    // Token nuevo con el TTL del horario nuevo; el viejo se quema para que no
    // queden dos links vivos apuntando a la misma cita.
    await this.sessions.invalidateManage(token);
    let manageUrl: string | undefined;
    try {
      manageUrl = await this.issueManageUrl(updated, slug);
    } catch (e) {
      this.logger.error(
        `no se pudo re-emitir el manage token slug=${slug} apptId=${updated.id}: ${(e as Error).message}`,
      );
    }

    this.logger.log(
      `appointment rescheduled via link slug=${slug} apptId=${updated.id}`,
    );
    return {
      appointment: {
        id: updated.id,
        serviceId: updated.serviceId,
        serviceName: appointment.service.name,
        professionalId: updated.professionalId,
        professionalName: appointment.professional.name,
        startAtISO: updated.startAt.toISOString(),
        durationMin: appointment.service.durationMin,
        status: updated.status,
      },
      ...(manageUrl ? { manageUrl } : {}),
    };
  }
}
