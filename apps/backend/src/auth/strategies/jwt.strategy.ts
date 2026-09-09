import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';
import { AuthUser } from '../decorators/current-user.decorator';
import { ClinicStatusCache } from '../../common/redis/clinic-status.cache';

/**
 * Payload del JWT que firmamos en `AuthService.login` y también en el flujo
 * de impersonation (`ImpersonationService.createImpersonationToken`, ver ADR 0014).
 * - `sub` = `user.id` (convención estándar).
 * - `clinicId` puede ser null para SUPERADMIN sin impersonar.
 * - `role` viaja siempre para que el `RolesGuard` no tenga que ir a DB.
 * - `impersonatedBy` sólo está presente en JWTs emitidos por el flujo de
 *   impersonation. Guarda el userId del SUPERADMIN original para poder
 *   auditarlo aun cuando el token opera como CLINIC_ADMIN.
 */
export interface JwtPayload {
  sub: string;
  clinicId: string | null;
  role: Role;
  impersonatedBy?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(private readonly clinicStatus: ClinicStatusCache) {
    // El secret se resuelve UNA vez al construir la estrategia. Si falta en
    // prod, `main.ts` ya fail-fast'ea; en dev usamos un fallback para no
    // frenar el bootstrap local.
    const secret =
      process.env.JWT_SECRET ??
      (process.env.NODE_ENV === 'production'
        ? // Nunca deberíamos llegar acá en prod (main.ts valida), pero por si
          // acaso, tirar ruidoso en lugar de arrancar con un secret vacío.
          (() => {
            throw new Error('JWT_SECRET missing in production');
          })()
        : 'dev-jwt-secret');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      // Forzamos HS256 en verify. Sin esto un atacante podría firmar con otro
      // algoritmo simétrico (HS384/HS512) y passport-jwt aceptaría porque el
      // secret es el mismo — no rompe la firma, pero rompe la política de
      // "un único algoritmo" que queremos mantener para poder rotar/migrar
      // sin dudas. Lista blanca explícita.
      algorithms: ['HS256'],
    });
  }

  /**
   * `validate` corre DESPUÉS de la verificación de firma + expiración.
   * Lo que devolvemos acá se inyecta como `req.user`. Mantenemos el shape
   * chico (userId, clinicId, role) para no filtrar más de lo necesario y
   * para que el `@CurrentUser()` decorator tenga un contrato estable.
   *
   * No vamos a DB por el usuario: si un user es desactivado, su JWT sigue
   * siendo válido hasta que expire (aceptable para MVP, expiración de 24h).
   *
   * Excepción (F1.4.T4): tokens de IMPERSONATION. Duran 30 min y operan
   * como CLINIC_ADMIN de una clínica concreta; si el SUPERADMIN la suspende
   * mientras el token vive, el acceso debe cortarse. Re-validamos
   * `Clinic.status === 'ACTIVE'` en cada request vía `ClinicStatusCache`
   * (Redis TTL 60 s, fail-closed a DB). Los tokens de login normal no
   * consultan nada.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (payload.impersonatedBy && payload.clinicId) {
      let active: boolean;
      try {
        active = await this.clinicStatus.isActive(payload.clinicId);
      } catch (e) {
        // Fail-closed: sin poder verificar, no dejamos pasar.
        this.logger.warn(
          `no se pudo verificar status de clínica para impersonation clinicId=${payload.clinicId}: ${(e as Error).message}`,
        );
        throw new UnauthorizedException('no se pudo validar la clínica');
      }
      if (!active) {
        this.logger.warn(
          `impersonation rechazada: clínica no activa clinicId=${payload.clinicId} by=${payload.impersonatedBy}`,
        );
        throw new UnauthorizedException('la clínica no está activa');
      }
    }

    return {
      userId: payload.sub,
      clinicId: payload.clinicId,
      role: payload.role,
      // Sólo se propaga si el token viene del flujo de impersonation
      // (ADR 0014). En login normal queda `undefined` y el `AuthUser`
      // no lleva la marca — cero riesgo de false-positive en auditoría.
      impersonatedBy: payload.impersonatedBy,
    };
  }
}
