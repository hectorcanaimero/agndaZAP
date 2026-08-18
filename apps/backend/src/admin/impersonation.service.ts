import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminAction } from '@prisma/client';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';

/** Duración del JWT temporal de impersonation. 30 minutos alcanza para
 * troubleshooting sin dejar tokens vivos horas si el super se olvida de salir. */
const IMPERSONATION_TTL_SECONDS = 30 * 60;
/** String equivalente para `jwt.sign({ expiresIn })`. Mantener sincronizado. */
const IMPERSONATION_TTL = '30m';

export interface CreateImpersonationInput {
  actorUserId: string;
  targetClinicId: string;
  ip?: string;
  userAgent?: string;
}

export interface ImpersonationResult {
  token: string;
  expiresAt: Date;
  clinic: {
    id: string;
    name: string;
    slug: string;
  };
}

/**
 * ImpersonationService — flujo de "entrar como esta clínica" del SUPERADMIN.
 *
 * Reemplazo del escape hatch viejo (`?clinicId=` en query). Ver ADR 0014.
 *
 * WHY: el SUPERADMIN necesita operar sobre una clínica para diagnosticar
 * incidentes, pero permitirle inyectar `clinicId` por query era un vector
 * de fuga cross-tenant (datos de salud). Emitimos en su lugar un JWT
 * temporal (30 min) con `clinicId` seteado + `impersonatedBy` para dejar
 * traza en cada request y en el trail de `AdminAudit`.
 *
 * Contrato de seguridad:
 *  - Sólo clínicas `ACTIVE` se pueden impersonar (no se pueden "revivir"
 *    clínicas SUSPENDED/ARCHIVED desde acá).
 *  - Cada `START_IMPERSONATION` queda persistido en `AdminAudit` ANTES de
 *    devolver el token; si el log falla, el token no se emite.
 *  - El TTL corto acota el blast radius si el token filtra.
 */
@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger('ImpersonationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  /**
   * Emite un JWT de impersonation y persiste el audit. Devuelve el token +
   * metadata mínima de la clínica destino para que el frontend pueda mostrar
   * un banner "estás operando como <clinic.name>".
   */
  async createImpersonationToken(
    input: CreateImpersonationInput,
  ): Promise<ImpersonationResult> {
    // Sólo campos que necesitamos + gate de status. `select` explícito para
    // no traer PII innecesaria de la clínica al log/response.
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: input.targetClinicId },
      select: { id: true, name: true, slug: true, status: true },
    });

    if (!clinic) {
      throw new NotFoundException('clínica no encontrada');
    }

    if (clinic.status !== 'ACTIVE') {
      // 400 y no 403: es un estado del recurso, no un problema de permisos.
      // Suspender/archivar es una acción deliberada del SaaS Admin — impersonar
      // esa clínica sería contradictorio con la razón por la que se suspendió.
      throw new BadRequestException(
        clinic.status === 'SUSPENDED'
          ? 'no se puede impersonar clínica suspendida'
          : 'no se puede impersonar clínica archivada',
      );
    }

    // Firmamos con el shape estándar de `JwtPayload` para que `JwtStrategy`
    // lo entienda igual que un login normal. La diferencia clave: `sub` sigue
    // siendo el userId del SUPERADMIN (NO creamos un user "sombra"), pero
    // `role` se degrada a CLINIC_ADMIN para pasar los guards del panel. La
    // trazabilidad queda en `impersonatedBy`.
    const payload: JwtPayload = {
      sub: input.actorUserId,
      clinicId: clinic.id,
      role: 'CLINIC_ADMIN',
      impersonatedBy: input.actorUserId,
    };
    const token = await this.jwt.signAsync(payload, {
      expiresIn: IMPERSONATION_TTL,
    });

    // Persistimos ANTES de retornar. Si falla el audit, el error se propaga
    // y el token no llega al cliente — evita el caso "token emitido sin traza".
    await this.adminAudit.logAction({
      actorUserId: input.actorUserId,
      action: AdminAction.START_IMPERSONATION,
      targetType: 'Clinic',
      targetId: clinic.id,
      metadata: { targetClinicSlug: clinic.slug },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    // `expiresAt` calculado desde `now` — no leemos el `exp` del JWT para no
    // depender del `iat` interno de la lib. 30 min ± segundos es aceptable.
    const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000);

    this.logger.log(
      `impersonation start actor=${input.actorUserId} target=${clinic.id}`,
    );

    return {
      token,
      expiresAt,
      clinic: {
        id: clinic.id,
        name: clinic.name,
        slug: clinic.slug,
      },
    };
  }
}
