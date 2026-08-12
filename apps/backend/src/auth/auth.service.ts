import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { DUMMY_HASH, verifyPassword } from './password.util';
import { JwtPayload } from './strategies/jwt.strategy';

/**
 * Respuesta agnóstica al transporte. El controller envuelve en `{ accessToken }`.
 */
export interface LoginResult {
  accessToken: string;
}

/**
 * Snapshot del user + su clínica (si aplica). Usado por `GET /auth/me`.
 * NUNCA incluye `password`.
 *
 * `onboardingCompletedAt` y `onboardingProgress` los consume el wizard
 * (`/[locale]/onboarding/*`) para hidratar estado en SSR + decidir redirect.
 * El middleware Next.js NO lee esto — usa un cookie hint por performance,
 * pero panel/layout.tsx re-setea la cookie desde este snapshot en cada carga.
 */
export interface AuthMe {
  id: string;
  email: string;
  name: string;
  role: Role;
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    locale: string;
    onboardingCompletedAt: Date | null;
    onboardingProgress: unknown;
  } | null;
}

/** Ventana del rate-limit por email en segundos. 15 min es el default clásico. */
const LOGIN_FAIL_WINDOW_SEC = 900;
/** Máximo de fails permitidos en la ventana antes de tirar 429. */
const LOGIN_FAIL_MAX = 5;

/**
 * Hash truncado del email — nunca guardamos el email en la key Redis. sha256
 * completo son 64 chars hex → truncamos a 16 para keys más cortas manteniendo
 * suficiente resistencia a colisión para este uso (contador transitorio).
 */
export function hashEmailForKey(email: string): string {
  return createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Login flow. Diseño anti-enumeración + anti-timing + anti-brute:
   *
   * 1. **Rate-limit por email hasheado** (defensa contra rotación de IP).
   *    Ventana 15 min, máximo 5 fails. Excede → 429.
   * 2. Buscamos por email (ya normalizado por el DTO).
   * 3. Si el user NO existe, corremos igual una `bcrypt.compare` contra un
   *    hash dummy para que el response time sea similar al caso "user existe
   *    pero password mala". Sin esto, un atacante puede enumerar emails
   *    válidos por diferencia de latencia (~100ms).
   * 4. En AMBAS ramas de fracaso: INCR contador por email + tirar el mismo
   *    mensaje genérico "credenciales inválidas".
   * 5. Éxito → DEL del contador (limpiamos historial de fails).
   * 6. Log SIN PII: solo `userId` + `role`. NUNCA el email.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const emailKey = `login_fail:${hashEmailForKey(email)}`;

    // Rate-limit por email. Consultamos el counter ACTUAL antes de intentar.
    // Si ya está sobre el umbral, cortamos con 429. Si Redis está caído
    // (`get` tira o devuelve null) seguimos fail-open — el rate-limit por
    // IP del guard sigue vigente como capa 1.
    const currentFails = await this.getFailCount(emailKey);
    if (currentFails >= LOGIN_FAIL_MAX) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'demasiados intentos, probá en un rato',
          retryAfter: LOGIN_FAIL_WINDOW_SEC,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Timing-attack mitigation: gastar el mismo tiempo de CPU que un login real.
      await verifyPassword(password, DUMMY_HASH);
      await this.incrementFail(emailKey);
      throw new UnauthorizedException('credenciales inválidas');
    }

    const ok = await verifyPassword(password, user.password);
    if (!ok) {
      await this.incrementFail(emailKey);
      throw new UnauthorizedException('credenciales inválidas');
    }

    const payload: JwtPayload = {
      sub: user.id,
      clinicId: user.clinicId,
      role: user.role,
    };
    // `expiresIn` y `algorithm` se resuelven desde `JwtModule.register` en
    // auth.module.ts (24h + HS256). No pasar options acá evita divergencia
    // entre módulo y service — un sólo lugar donde configurar la firma.
    const accessToken = await this.jwt.signAsync(payload);

    // Login exitoso → limpiamos el contador de fails.
    await this.clearFail(emailKey);

    this.logger.log(`auth login ok user=${user.id} role=${user.role}`);
    return { accessToken };
  }

  /**
   * Devuelve el user + clínica para `GET /auth/me`.
   * NUNCA retorna el hash del password.
   */
  async me(userId: string): Promise<AuthMe> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        clinic: {
          select: {
            id: true,
            name: true,
            slug: true,
            timezone: true,
            locale: true,
            onboardingCompletedAt: true,
            onboardingProgress: true,
          },
        },
      },
    });
    if (!user) {
      // Edge case: el JWT es válido pero el user fue borrado. Tratamos como 401.
      throw new UnauthorizedException('sesión inválida');
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clinic: user.clinic,
    };
  }

  /** Lee el contador. Si Redis falla, devolvemos 0 (fail-open a nivel email). */
  private async getFailCount(key: string): Promise<number> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null || raw === undefined) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch (e) {
      this.logger.error(
        `redis get login_fail falló: ${(e as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * INCR + EXPIRE (idempotente sobre EXPIRE). Si Redis falla logueamos, no
   * cortamos el flow — el guard IP sigue siendo la primera línea.
   */
  private async incrementFail(key: string): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, LOGIN_FAIL_WINDOW_SEC);
      await pipeline.exec();
    } catch (e) {
      this.logger.error(
        `redis incr login_fail falló: ${(e as Error).message}`,
      );
    }
  }

  private async clearFail(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (e) {
      this.logger.error(
        `redis del login_fail falló: ${(e as Error).message}`,
      );
    }
  }
}
