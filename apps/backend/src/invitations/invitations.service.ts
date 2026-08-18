import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { hashPassword } from '../auth/password.util';
import { PrismaService } from '../prisma/prisma.service';

/** TTL default en días. 7 es el estándar SaaS (Notion/Linear/Vercel). */
export const INVITATION_TTL_DAYS = 7;

export interface CreateInvitationInput {
  userId: string;
  invitedByUserId?: string;
  /** Override del TTL en días (default `INVITATION_TTL_DAYS`). */
  ttlDays?: number;
}

export interface CreateInvitationResult {
  token: string;
  expiresAt: Date;
}

/**
 * Info "safe" que expone `GET /public/invitations/:token` — todo lo que
 * la página pública necesita para saludar y contextualizar al invitado
 * SIN filtrar info sensible (ej: userId, clinicId, invitedBy email, etc).
 */
export interface PublicInvitationInfo {
  email: string;
  invitedName: string;
  clinicName: string;
  expiresAt: Date;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger('InvitationsService');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Genera una invitación para un `userId`. Si ya existe una invitación
   * (sea pendiente, aceptada o expirada) la BORRAMOS y creamos una nueva.
   * Motivo: mantener el modelo 1:1 simple; el super puede "reenviar" sin
   * lógica extra.
   *
   * El token son 32 bytes random en hex (64 chars). Es URL-safe y tiene
   * ~256 bits de entropía — impracticable de fuerza bruta.
   */
  async create(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    const token = randomBytes(32).toString('hex');
    const ttlDays = input.ttlDays ?? INVITATION_TTL_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    // upsert manual: primero borrar (si existe), después crear. `deleteMany`
    // no falla si no había — más simple que try/catch sobre un unique.
    await this.prisma.invitation.deleteMany({
      where: { userId: input.userId },
    });

    await this.prisma.invitation.create({
      data: {
        token,
        userId: input.userId,
        invitedByUserId: input.invitedByUserId ?? null,
        expiresAt,
      },
    });

    return { token, expiresAt };
  }

  /**
   * Lookup público por token. Devuelve solo campos "safe" para la página
   * de aceptación (sin userId, sin metadata sensible).
   *
   * Tira:
   *  - 404 si el token no existe (o fue borrado por un resend).
   *  - 410 si ya fue aceptado o expiró — el link es de un solo uso y
   *    finito, y una vez consumido no debe volver a servir contenido.
   */
  async getByToken(token: string): Promise<PublicInvitationInfo> {
    const inv = await this.prisma.invitation.findUnique({
      where: { token },
      include: {
        user: {
          select: {
            email: true,
            name: true,
            clinic: { select: { name: true } },
          },
        },
      },
    });

    if (!inv) {
      throw new NotFoundException('invitación no encontrada');
    }
    if (inv.acceptedAt) {
      throw new GoneException('invitación ya utilizada');
    }
    if (inv.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('invitación expirada');
    }
    if (!inv.user.clinic) {
      // Defensivo: user sin clínica no debería estar en el flow de invitación
      // (solo CLINIC_ADMIN se invita — SUPERADMIN se crea por seed/CLI).
      throw new ConflictException('invitación en estado inválido');
    }

    return {
      email: inv.user.email,
      invitedName: inv.user.name,
      clinicName: inv.user.clinic.name,
      expiresAt: inv.expiresAt,
    };
  }

  /**
   * Consume la invitación: hashea el password + lo asigna al User + marca
   * `acceptedAt`. Todo en una transacción para no dejar la invitación
   * marcada como usada si el update del password falla.
   *
   * Contrato de idempotencia: aceptar dos veces el mismo token = 410 en la
   * segunda porque `acceptedAt` ya está seteado.
   */
  async accept(token: string, plainPassword: string): Promise<void> {
    const inv = await this.prisma.invitation.findUnique({
      where: { token },
    });

    if (!inv) throw new NotFoundException('invitación no encontrada');
    if (inv.acceptedAt) throw new GoneException('invitación ya utilizada');
    if (inv.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('invitación expirada');
    }

    // Hash FUERA de la transacción (bcrypt es CPU-heavy — no queremos tener
    // el lock de DB abierto mientras).
    const passwordHash = await hashPassword(plainPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: inv.userId },
        data: { password: passwordHash },
      }),
      this.prisma.invitation.update({
        where: { id: inv.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    this.logger.log(`invitation accepted user=${inv.userId}`);
  }
}
