import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { ListPatientsDto } from './dto/list-patients.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';

/**
 * `Patient` — vista consolidada del paciente y su historial en la clínica.
 *
 * NO exponemos `POST /` — los pacientes nacen automáticamente al crear una
 * cita (panel o página pública) o cuando el bot completa el flujo por
 * WhatsApp. Un "nuevo paciente" desde el panel es baja prioridad; se agrega
 * cuando aparezca la demanda.
 *
 * `PATCH /:id` sólo permite editar `name` y `consent`. Cambios sensibles
 * (phone, merge de duplicados, revoke consent) son follow-ups aparte con
 * flujos de auditoría (ver ADR 0004 §PII).
 *
 * Multi-tenant: todas las queries pasan por `tenantWhere(user)`.
 * (Fase 6: clinicId override removido — el scope siempre viene del JWT)
 * Nunca fugamos pacientes entre clínicas.
 */
@Controller('patients')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class PatientsController {
  private readonly logger = new Logger('PatientsController');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /api/patients?q=&limit=&offset=`
   *
   * Lista paginada. Búsqueda case-insensitive en `name` y `phone` (Postgres
   * ILIKE via Prisma `contains + mode: insensitive`). Ordenados por nombre
   * (nulls last), tie-break por phone. Cada row viene con `_count.appointments`
   * para el badge de "N citas" sin necesitar N+1.
   */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() q: ListPatientsDto,
  ) {
    const scope = tenantWhere(user);
    const search = q.q?.trim();

    const where: Prisma.PatientWhereInput = {
      ...scope,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.patient.findMany({
        where,
        // Ordenamos por nombre ascending (nulls last) — Prisma no expone
        // NULLS LAST directo, hacemos dos orderBy: primero por presencia,
        // después alfabético. Alternativa: subir a raw SQL si escala.
        orderBy: [{ name: 'asc' }, { phone: 'asc' }],
        take: q.limit ?? 50,
        skip: q.offset ?? 0,
        select: {
          id: true,
          phone: true,
          name: true,
          consent: true,
          createdAt: true,
          _count: { select: { appointments: true } },
        },
      }),
      this.prisma.patient.count({ where }),
    ]);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        name: r.name,
        consent: r.consent,
        createdAt: r.createdAt,
        appointmentCount: r._count.appointments,
      })),
      total,
    };
  }

  /**
   * `GET /api/patients/:id`
   *
   * Detalle del paciente + contadores. NO trae el historial completo (usar
   * `/:id/history` para eso — separar mantiene esta call barata en el listado
   * lateral del panel donde solo mostramos el header).
   */
  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    const scope = tenantWhere(user);
    const patient = await this.prisma.patient.findFirst({
      where: { id, ...scope },
      select: {
        id: true,
        phone: true,
        name: true,
        consent: true,
        createdAt: true,
        _count: { select: { appointments: true, conversations: true } },
      },
    });
    if (!patient) throw new NotFoundException('paciente no encontrado');
    return {
      id: patient.id,
      phone: patient.phone,
      name: patient.name,
      consent: patient.consent,
      createdAt: patient.createdAt,
      appointmentCount: patient._count.appointments,
      conversationCount: patient._count.conversations,
    };
  }

  /**
   * `GET /api/patients/:id/history`
   *
   * Timeline unificada:
   * - `appointments`: últimas 50 citas ordenadas desc por startAt (más
   *   recientes primero). Incluye servicio + profesional (name only).
   * - `conversation`: primera conversación ligada al paciente (uno-a-uno
   *   típico; si hay más, tomar la más reciente). Solo id + estado + último
   *   mensaje — el detalle completo vive en `/api/conversations/:id`.
   *
   * NO incluye `notes` de las citas — el listado en el panel no las necesita
   * y evita fugas de PII en el response.
   */
  @Get(':id/history')
  async history(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    const scope = tenantWhere(user);
    const patient = await this.prisma.patient.findFirst({
      where: { id, ...scope },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('paciente no encontrado');

    const [appointments, conversation] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { patientId: id, ...scope },
        orderBy: { startAt: 'desc' },
        take: 50,
        select: {
          id: true,
          startAt: true,
          endAt: true,
          status: true,
          service: { select: { id: true, name: true, durationMin: true } },
          professional: { select: { id: true, name: true } },
        },
      }),
      this.prisma.conversation.findFirst({
        where: { patientId: id, ...scope },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          state: true,
          updatedAt: true,
          contactName: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { body: true, direction: true, createdAt: true },
          },
        },
      }),
    ]);

    return {
      appointments,
      conversation: conversation
        ? {
            id: conversation.id,
            state: conversation.state,
            updatedAt: conversation.updatedAt,
            contactName: conversation.contactName,
            lastMessage: conversation.messages[0] ?? null,
          }
        : null,
    };
  }

  /**
   * `PATCH /api/patients/:id`
   *
   * Edita `name` y/o `consent`. Consent solo puede prenderse (ratchet legal
   * LGPD/GDPR — apagar consent debería ser un evento auditado, no un
   * toggle desde el panel). Si `consent: false` viene en el body y el actual
   * es `true`, el backend lo ignora en silencio.
   */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdatePatientDto,
  ) {
    const scope = tenantWhere(user);
    const existing = await this.prisma.patient.findFirst({
      where: { id, ...scope },
      select: { id: true, consent: true },
    });
    if (!existing) throw new NotFoundException('paciente no encontrado');

    const data: Prisma.PatientUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    // Consent ratchet: solo aceptamos consent=true. Revocar es follow-up
    // con auditoría (AuditEvent — ver ADR 0006 §Deuda).
    if (dto.consent === true && !existing.consent) data.consent = true;

    if (Object.keys(data).length === 0) {
      // No-op — evita un UPDATE innecesario y su updatedAt bump.
      return this.findOne(user, id);
    }

    const updated = await this.prisma.patient.update({
      where: { id },
      data,
      select: {
        id: true,
        phone: true,
        name: true,
        consent: true,
        createdAt: true,
        _count: { select: { appointments: true, conversations: true } },
      },
    });

    this.logger.log(
      `patient update patientId=${id} by=${user.userId} keys=${Object.keys(data).join(',')}`,
    );

    return {
      id: updated.id,
      phone: updated.phone,
      name: updated.name,
      consent: updated.consent,
      createdAt: updated.createdAt,
      appointmentCount: updated._count.appointments,
      conversationCount: updated._count.conversations,
    };
  }
}
