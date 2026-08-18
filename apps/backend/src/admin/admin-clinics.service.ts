import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClinicStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { hashPassword } from '../auth/password.util';
import { InvitationsService } from '../invitations/invitations.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Tipos de entrada ────────────────────────────────────────────────────────

export interface CreateClinicInput {
  name: string;
  slug: string;
  timezone?: string;
  locale?: string;
  wahaSession: string;
  address?: string;
  admin: {
    email: string;
    name: string;
  };
  /**
   * userId del SUPERADMIN que dispara la creación. Se persiste como
   * `invitedByUserId` en la Invitation para trazabilidad.
   */
  invitedByUserId?: string;
  /**
   * Base URL para armar el link de invitación (`{appBaseUrl}/{locale}/invite/{token}`).
   * Default: `process.env.APP_BASE_URL ?? 'http://localhost:3002'`.
   */
  appBaseUrl?: string;
}

export interface ListClinicsInput {
  status?: ClinicStatus;
  search?: string;
  page: number;
  pageSize: number;
}

export interface UpdateClinicInput {
  name?: string;
  timezone?: string;
  locale?: string;
  address?: string;
}

// ─── Tipos de salida ─────────────────────────────────────────────────────────

export interface CreateClinicResult {
  /** ID de la clínica — usado por el interceptor como targetId. */
  id: string;
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    locale: string;
    wahaSession: string;
    status: ClinicStatus;
    createdAt?: Date;
  };
  admin: {
    id: string;
    email: string;
    name: string;
  };
  /**
   * Info de la invitación generada para el primer admin. El SUPERADMIN
   * la usa como fallback si el email nunca llega — puede copiar
   * `invitation.url` y pasársela al cliente por otro canal.
   */
  invitation: {
    url: string;
    expiresAt: Date;
    /** `true` si el email se envió OK; `false` si falló (dev-fallback también → true). */
    emailSent: boolean;
  };
}

export interface ClinicListItem {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  locale: string;
  status: ClinicStatus;
  suspendedAt: Date | null;
  _count: {
    professionals: number;
    appointments: number;
  };
}

export interface ListClinicsResult {
  items: ClinicListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClinicMetrics {
  professionals: number;
  servicesActive: number;
  appointmentsLast30d: number;
  noShowRateLast30d: number;
  patients: number;
}

export interface GetClinicResult {
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    locale: string;
    wahaSession: string;
    status: ClinicStatus;
    suspendedAt: Date | null;
    suspendedReason: string | null;
    address: string | null;
  };
  metrics: ClinicMetrics;
}

/**
 * AdminClinicsService — lógica de negocio para el CRUD cross-tenant de clínicas.
 *
 * No aplica tenantWhere porque SUPERADMIN opera SOBRE tenants; no pertenece a uno.
 * La validación de rol la hace el controller vía @Roles('SUPERADMIN').
 */
@Injectable()
export class AdminClinicsService {
  private readonly logger = new Logger('AdminClinicsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitations: InvitationsService,
    private readonly mail: MailService,
  ) {}

  /**
   * Crea la clínica, el primer usuario CLINIC_ADMIN, y una Invitation
   * para que el usuario active su cuenta (elija su propia password).
   *
   * Password inicial:
   *   Se genera 32 bytes hex random y se hashea con bcrypt. NUNCA se
   *   expone en la respuesta ni se persiste en claro. Cuando el usuario
   *   acepta la invitación, ese hash se reemplaza por el hash de la
   *   password que él eligió.
   *
   * Email:
   *   Fire-and-forget POR DENTRO del método — esperamos el resultado
   *   pero un fallo NO tumba la creación. El `invitation.url` viaja en
   *   la respuesta para que el super pueda pasarlo por otro canal si el
   *   email nunca llega. En dev sin `RESEND_API_KEY` el MailService
   *   loguea y retorna `ok:true` (fallback).
   */
  async create(input: CreateClinicInput): Promise<CreateClinicResult> {
    // Password random hasheado — el hash queda en DB hasta que la Invitation
    // se acepta y el user setea el suyo. 32 bytes hex = 64 chars, sobra en
    // entropía y no importa la performance (bcrypt es lento por diseño).
    const initialPasswordHash = await hashPassword(
      randomBytes(32).toString('hex'),
    );

    const [clinic, admin] = await this.prisma.$transaction(async (tx) => {
      const newClinic = await tx.clinic.create({
        data: {
          name: input.name,
          slug: input.slug,
          timezone: input.timezone ?? 'America/Caracas',
          locale: input.locale ?? 'es',
          wahaSession: input.wahaSession,
          address: input.address ?? null,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          locale: true,
          wahaSession: true,
          status: true,
        },
      });

      const newAdmin = await tx.user.create({
        data: {
          clinicId: newClinic.id,
          email: input.admin.email,
          name: input.admin.name,
          password: initialPasswordHash,
          role: 'CLINIC_ADMIN',
        },
        select: { id: true, email: true, name: true },
      });

      return [newClinic, newAdmin] as const;
    });

    // Fuera de la txn: la invitación es un side effect no crítico para la
    // atomicidad de "clínica + user". Si esto falla, el super puede
    // reenviar la invitación desde el detalle (endpoint futuro).
    const invitation = await this.invitations.create({
      userId: admin.id,
      invitedByUserId: input.invitedByUserId,
    });

    const appBaseUrl =
      input.appBaseUrl ?? process.env.APP_BASE_URL ?? 'http://localhost:3002';
    const locale: 'es' | 'pt' = clinic.locale === 'pt' ? 'pt' : 'es';
    const inviteUrl = `${appBaseUrl.replace(/\/$/, '')}/${locale}/invite/${invitation.token}`;

    let emailSent = false;
    try {
      const mailRes = await this.mail.sendClinicInvitation({
        to: admin.email,
        invitedName: admin.name,
        clinicName: clinic.name,
        inviteUrl,
        expiresAt: invitation.expiresAt,
        locale,
      });
      emailSent = mailRes.ok;
      if (!mailRes.ok) {
        this.logger.warn(
          `invitation email FAILED clinic=${clinic.id} user=${admin.id} — el super puede copiar la URL del response`,
        );
      }
    } catch (e) {
      // Nunca debería ocurrir (el MailService ya captura), pero blindamos.
      this.logger.error(
        `invitation email threw clinic=${clinic.id}: ${(e as Error).message}`,
      );
    }

    return {
      id: clinic.id, // el interceptor lee esto como targetId via 'response.id'
      clinic,
      admin,
      invitation: {
        url: inviteUrl,
        expiresAt: invitation.expiresAt,
        emailSent,
      },
    };
  }

  /**
   * Listado paginado con filtros opcionales por status y búsqueda de texto.
   * Incluye counts de professionals y appointments para el panel de overview.
   */
  async list(input: ListClinicsInput): Promise<ListClinicsResult> {
    const { status, search, page, pageSize } = input;

    const where: Prisma.ClinicWhereInput = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.clinic.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          locale: true,
          status: true,
          suspendedAt: true,
          _count: {
            select: {
              professionals: true,
              appointments: true,
            },
          },
        },
      }),
      this.prisma.clinic.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Detalle completo de una clínica con métricas operativas.
   * Las métricas son aproximaciones útiles para el panel; no reemplazan
   * reportes analíticos profundos.
   */
  async get(id: string): Promise<GetClinicResult> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        locale: true,
        wahaSession: true,
        status: true,
        suspendedAt: true,
        suspendedReason: true,
        address: true,
      },
    });

    if (!clinic) {
      throw new NotFoundException(`Clínica ${id} no encontrada`);
    }

    const metrics = await this.getMetrics(id);

    return { clinic, metrics };
  }

  /**
   * Actualización parcial de campos editables. `slug`, `wahaSession` y `status`
   * NO se exponen aquí — el slug es inmutable post-creación y el status
   * se gestiona vía `/suspend` y `/reactivate`.
   */
  async update(id: string, input: UpdateClinicInput): Promise<{ id: string }> {
    await this.ensureExists(id);

    await this.prisma.clinic.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
      },
    });

    return { id };
  }

  /**
   * Suspende la clínica y registra la razón. Si ya está suspendida, 409 —
   * para evitar que el SUPERADMIN sobreescriba accidentalmente el motivo original.
   */
  async suspend(id: string, reason: string): Promise<{ id: string }> {
    const clinic = await this.ensureExists(id);

    if (clinic.status === ClinicStatus.SUSPENDED) {
      throw new ConflictException(`Clínica ${id} ya está suspendida`);
    }

    await this.prisma.clinic.update({
      where: { id },
      data: {
        status: ClinicStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspendedReason: reason,
      },
    });

    return { id };
  }

  /**
   * Reactiva una clínica suspendida. 409 si ya está activa — idempotencia
   * controlada: el caller debe saber en qué estado está antes de actuar.
   */
  async reactivate(id: string): Promise<{ id: string }> {
    const clinic = await this.ensureExists(id);

    if (clinic.status === ClinicStatus.ACTIVE) {
      throw new ConflictException(`Clínica ${id} ya está activa`);
    }

    await this.prisma.clinic.update({
      where: { id },
      data: {
        status: ClinicStatus.ACTIVE,
        suspendedAt: null,
        suspendedReason: null,
      },
    });

    return { id };
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────

  /**
   * Calcula métricas operativas de los últimos 30 días para el detalle.
   * El noShow rate se calcula sólo sobre citas con outcome definido —
   * citas pendientes no cuentan como denominador (sesgo estadístico).
   */
  async getMetrics(clinicId: string): Promise<ClinicMetrics> {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [
      professionals,
      servicesActive,
      appointmentsLast30d,
      noShowLast30d,
      appointmentsWithOutcomeLast30d,
      patients,
    ] = await this.prisma.$transaction([
      this.prisma.professional.count({ where: { clinicId } }),
      this.prisma.service.count({ where: { clinicId, active: true } }),
      this.prisma.appointment.count({
        where: { clinicId, startAt: { gte: since } },
      }),
      this.prisma.appointment.count({
        where: { clinicId, startAt: { gte: since }, status: 'NO_SHOW' },
      }),
      this.prisma.appointment.count({
        where: {
          clinicId,
          startAt: { gte: since },
          status: { in: ['ATENDIDA', 'NO_SHOW'] },
        },
      }),
      this.prisma.patient.count({ where: { clinicId } }),
    ]);

    const noShowRateLast30d =
      appointmentsWithOutcomeLast30d > 0
        ? noShowLast30d / appointmentsWithOutcomeLast30d
        : 0;

    return {
      professionals,
      servicesActive,
      appointmentsLast30d,
      noShowRateLast30d,
      patients,
    };
  }

  /** Garantiza que la clínica existe o tira 404. Reutilizado en update/suspend/reactivate. */
  private async ensureExists(
    id: string,
  ): Promise<{ id: string; status: ClinicStatus }> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!clinic) {
      throw new NotFoundException(`Clínica ${id} no encontrada`);
    }

    return clinic;
  }
}
