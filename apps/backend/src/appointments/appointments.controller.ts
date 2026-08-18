import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import {
  assertReschedulable,
  assertTransition,
} from './appointment-status.util';
import { CreatePanelAppointmentDto } from './dto/create-appointment.dto';
import { ListAppointmentsQueryDto } from './dto/list-appointments.dto';
import { PatchStatusDto } from './dto/patch-status.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

/**
 * Controller de citas para el Panel.
 *
 * - `GET /` — lista filtrable (CLINIC_ADMIN, SUPERADMIN).
 * - `GET /mine` — agenda del profesional autenticado (PROFESSIONAL).
 * - `GET /:id` — detalle.
 * - `PATCH /:id/status` — transición controlada + side effects en reminders.
 * - `POST /` — crea manual desde mostrador.
 *
 * NO exponemos `DELETE`. El "borrar" es `PATCH status = CANCELADA`.
 *
 * Multi-tenant: TODAS las queries pasan por `tenantWhere(user)`.
 * (Fase 6: clinicId override removido — el scope siempre viene del JWT)
 * El PROFESSIONAL tiene su propia rama con filtro adicional por `professionalId`.
 *
 * PII: Reducimos la exposición en `list()` — sólo devolvemos el `name` del
 * paciente y `phone` (necesario para contactar). NO devolvemos `notes` en la
 * lista (sólo en el detalle) — quien mira agenda no necesita ver notas médicas.
 */
@Controller('appointments')
@UseGuards(RolesGuard)
export class AppointmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: RemindersService,
    private readonly followUps: FollowUpsService,
    private readonly scheduling: SchedulingService,
    private readonly availability: AvailabilityService,
    @InjectPinoLogger(AppointmentsController.name)
    private readonly logger: PinoLogger,
  ) {}

  @Get()
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() q: ListAppointmentsQueryDto,
  ) {
    const scope = tenantWhere(user);
    // Si viene `?professionalId=`, validamos que el profesional pertenece a
    // la clínica del scope. Sin esto, un filtro cross-tenant devolvería lista
    // vacía sin señalizar el error → 400 explícito (audit M6).
    if (q.professionalId) {
      const found = await this.prisma.professional.findFirst({
        where: { id: q.professionalId, ...scope },
        select: { id: true },
      });
      if (!found) {
        throw new BadRequestException(
          'professionalId no pertenece a esta clínica',
        );
      }
    }
    const where: Prisma.AppointmentWhereInput = {
      ...scope,
      ...(q.status ? { status: q.status } : {}),
      ...(q.professionalId ? { professionalId: q.professionalId } : {}),
      ...(q.from || q.to
        ? {
            startAt: {
              ...(q.from ? { gte: DateTime.fromISO(q.from).toJSDate() } : {}),
              ...(q.to ? { lte: DateTime.fromISO(q.to).toJSDate() } : {}),
            },
          }
        : {}),
    };
    return this.prisma.appointment.findMany({
      where,
      orderBy: { startAt: 'asc' },
      take: q.limit ?? 50,
      skip: q.offset ?? 0,
      // Cero PII innecesaria: NO devolvemos `patient.consent` ni `notes` acá.
      // Sólo lo mínimo para renderizar la fila de agenda.
      select: {
        id: true,
        startAt: true,
        endAt: true,
        status: true,
        confirmedAt: true,
        canceledAt: true,
        outcome: true,
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, durationMin: true } },
        professional: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * GET /appointments/mine — usa el rol PROFESSIONAL.
   *
   * Diseño: el JWT del PROFESSIONAL NO trae `professionalId` (ver ADR 0005 §8).
   * Resolvemos con un `findUnique` sobre `User { professionalId }`. Es 1 query
   * extra pero acotada; se optimiza cuando el JWT incluya `professionalId`.
   *
   * Si el user es CLINIC_ADMIN/SUPERADMIN pegan a este endpoint, cortamos con
   * 403 — para "ver la agenda de otro" está `GET /?professionalId=` en el
   * endpoint principal.
   */
  @Get('mine')
  @Roles('PROFESSIONAL')
  async listMine(
    @CurrentUser() user: AuthUser,
    @Query() q: ListAppointmentsQueryDto,
  ) {
    // El rol ya está validado por RolesGuard; ForbiddenException es defensivo.
    if (user.role !== 'PROFESSIONAL') {
      throw new ForbiddenException('sólo profesionales pueden usar este endpoint');
    }
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { professionalId: true, clinicId: true },
    });
    if (!dbUser?.professionalId) {
      throw new NotFoundException('el usuario no tiene un profesional asociado');
    }
    const scope = tenantWhere(user);
    const where: Prisma.AppointmentWhereInput = {
      ...scope,
      professionalId: dbUser.professionalId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to
        ? {
            startAt: {
              ...(q.from ? { gte: DateTime.fromISO(q.from).toJSDate() } : {}),
              ...(q.to ? { lte: DateTime.fromISO(q.to).toJSDate() } : {}),
            },
          }
        : {}),
    };
    return this.prisma.appointment.findMany({
      where,
      orderBy: { startAt: 'asc' },
      take: q.limit ?? 50,
      skip: q.offset ?? 0,
      select: {
        id: true,
        startAt: true,
        endAt: true,
        status: true,
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, durationMin: true } },
      },
    });
  }

  /**
   * `GET /slots?serviceId&professionalId&from&days&excludeAppointmentId`
   *
   * Slot picker interno para el panel (agendar / reagendar). Deliberadamente
   * NO usa DTO — son 5 query params simples y el ValidationPipe global con
   * `forbidNonWhitelisted` haría más ruido que el que evita.
   *
   * `excludeAppointmentId` se pasa cuando se está reagendando una cita
   * existente: hace que su slot actual no aparezca ocupado (por sí misma).
   *
   * IMPORTANTE: registrado ANTES de `@Get(':id')` porque `slots` matcharía
   * como `:id` si van al revés.
   */
  @Get('slots')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async slots(
    @CurrentUser() user: AuthUser,
    @Query('serviceId') serviceId?: string,
    @Query('professionalId') professionalId?: string,
    @Query('from') fromISO?: string,
    @Query('days') daysRaw?: string,
    @Query('excludeAppointmentId') excludeAppointmentId?: string,
  ) {
    if (!serviceId || !professionalId || !fromISO) {
      throw new BadRequestException(
        'serviceId, professionalId y from son requeridos',
      );
    }
    const scope = tenantWhere(user);
    // Clamp para evitar queries pesadas si el frontend pide 365 días.
    const days = Math.min(30, Math.max(1, Number(daysRaw ?? '7')));
    return this.availability.getSlots({
      clinicId: scope.clinicId,
      serviceId,
      professionalId,
      fromISO,
      days,
      excludeAppointmentId,
      limit: 200,
    });
  }

  @Get(':id')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN', 'PROFESSIONAL')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    // PROFESSIONAL sólo puede ver sus propias citas.
    const scope = tenantWhere(user);
    const whereClause: Prisma.AppointmentWhereInput = { id, ...scope };
    if (user.role === 'PROFESSIONAL') {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.userId },
        select: { professionalId: true },
      });
      if (!dbUser?.professionalId) {
        throw new NotFoundException('cita no encontrada');
      }
      whereClause.professionalId = dbUser.professionalId;
    }
    const appt = await this.prisma.appointment.findFirst({
      where: whereClause,
      include: {
        patient: {
          select: { id: true, name: true, phone: true, consent: true },
        },
        service: true,
        professional: { select: { id: true, name: true } },
        reminders: {
          orderBy: { fireAt: 'asc' },
          select: {
            id: true,
            offsetH: true,
            fireAt: true,
            status: true,
            sentAt: true,
          },
        },
      },
    });
    if (!appt) throw new NotFoundException('cita no encontrada');
    return appt;
  }

  @Patch(':id/status')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async patchStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: PatchStatusDto,
  ) {
    const scope = tenantWhere(user);
    const existing = await this.prisma.appointment.findFirst({
      where: { id, ...scope },
    });
    if (!existing) throw new NotFoundException('cita no encontrada');

    // Validación FSM. Same-status es no-op (assertTransition lo tolera).
    assertTransition(existing.status, dto.status);

    // Actualizamos + side-effects. NO logueamos `reason` porque puede contener
    // datos del paciente ("cambió síntomas") → PII.
    const now = DateTime.now().toJSDate();
    const data: Prisma.AppointmentUpdateInput = { status: dto.status };
    switch (dto.status) {
      case AppointmentStatus.CONFIRMADA:
        data.confirmedAt = now;
        break;
      case AppointmentStatus.CANCELADA:
        data.canceledAt = now;
        break;
      case AppointmentStatus.ATENDIDA:
        data.outcome = 'atendio';
        break;
      case AppointmentStatus.NO_SHOW:
        data.outcome = 'no_show';
        break;
      default:
        break;
    }

    const updated = await this.prisma.appointment.update({
      where: { id },
      data,
    });

    // Side effects en reminders. Fail-open: si el side effect explota,
    // logueamos pero devolvemos el appointment ya actualizado (la fuente de
    // verdad es la DB). Si dejamos que explote se abre una ventana donde el
    // status quedó cambiado pero el caller cree que no.
    try {
      if (dto.status === AppointmentStatus.CONFIRMADA) {
        await this.reminders.confirmAppointment(id);
      } else if (
        dto.status === AppointmentStatus.CANCELADA ||
        dto.status === AppointmentStatus.NO_SHOW
      ) {
        await this.reminders.cancelForAppointment(id);
        // Además, si se revierte una ATENDIDA, cancelamos el follow-up
        // pendiente. `cancelForAppointment` es silent-fail.
        await this.followUps.cancelForAppointment(id);
      } else if (dto.status === AppointmentStatus.ATENDIDA) {
        // Encolamos el follow-up post-atención. Respeta la config del
        // profesional (`followUpEnabled` + `followUpDelayHours`). Si el
        // profesional lo tiene apagado, es no-op.
        await this.followUps.scheduleForAppointment(id);
      }
    } catch (e) {
      this.logger.error(
        `side-effect (reminders/follow-ups) falló apptId=${id} status=${dto.status}: ${(e as Error).message}`,
      );
    }

    // Log de auditoría (CERO PII). apptId + old→new. `reason` NO se loguea.
    this.logger.info(
      `appt status change apptId=${id} ${existing.status}->${dto.status} by=${user.userId}`,
    );

    return updated;
  }

  @Post()
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePanelAppointmentDto,
  ) {
    const scope = tenantWhere(user);
    // Normalizamos phone: agregamos `+` si no lo trae (E.164 estricto).
    const normalizedPhone = dto.phone.startsWith('+')
      ? dto.phone
      : `+${dto.phone}`;
    // Consent SIEMPRE obligatorio — no negociable. El rol interno
    // (SUPERADMIN incluido) no otorga consent en nombre del paciente. Es un
    // requisito legal (LGPD/GDPR datos de salud) que se materializa por acto
    // del paciente, no por privilegio de operador. Ver ADR 0006.
    // Defensa en profundidad: el DTO ya tiene @Equals(true), este check
    // cubre el caso hipotético de que se saltee el pipe.
    if (!dto.consent) {
      throw new BadRequestException(
        'consent es obligatorio al crear cita desde el panel',
      );
    }
    return this.scheduling.createAppointment({
      clinicId: scope.clinicId,
      patient: {
        phone: normalizedPhone,
        name: dto.name,
        consent: dto.consent === true,
      },
      serviceId: dto.serviceId,
      professionalId: dto.professionalId,
      startAtISO: dto.startAtISO,
      notes: dto.notes,
      // Nota: usamos 'PUBLIC' porque el SchedulingService sólo distingue BOT
      // vs PUBLIC (idempotencia). El panel comparte semántica con la página
      // pública (creación explícita, sin dedupe). Documentado en el CRUD MD.
      source: 'PUBLIC',
    });
  }

  /**
   * `PATCH /:id/reschedule` — mueve el startAt de una cita existente sin cambiar
   * paciente/servicio/profesional. Reprograma los recordatorios asociados.
   *
   * Errores:
   *  - 404 si la cita no existe en este tenant.
   *  - 422 si el status no permite reagendar (ATENDIDA/CANCELADA/NO_SHOW).
   *  - 400 si `startAtISO` es inválido o pasado.
   *  - 409 si el nuevo slot no está disponible (fuera BH, TimeOff, ya tomado).
   *
   * NO cambia el `status` — la cita reagendada mantiene su estado (PENDIENTE
   * queda PENDIENTE, CONFIRMADA queda CONFIRMADA). Si querés forzar re-confirmación,
   * pasá por PATCH /:id/status en flujo separado.
   */
  @Patch(':id/reschedule')
  @Roles('CLINIC_ADMIN', 'SUPERADMIN')
  async reschedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RescheduleAppointmentDto,
  ) {
    const scope = tenantWhere(user);
    // Cargar mínima: solo para chequear status + tenant. La lógica real vive
    // en `SchedulingService.rescheduleAppointment`.
    const existing = await this.prisma.appointment.findFirst({
      where: { id, ...scope },
      select: { id: true, status: true, startAt: true },
    });
    if (!existing) throw new NotFoundException('cita no encontrada');
    assertReschedulable(existing.status);

    const updated = await this.scheduling.rescheduleAppointment({
      clinicId: scope.clinicId,
      appointmentId: id,
      startAtISO: dto.startAtISO,
    });

    // Log de auditoría (CERO PII). apptId + old→new startAt.
    this.logger.info(
      `appt reschedule apptId=${id} ${existing.startAt.toISOString()}->${updated.startAt.toISOString()} by=${user.userId}`,
    );

    return updated;
  }
}
