import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../public/rate-limit.guard';

/**
 * ClinicStatusCache — "¿la clínica sigue ACTIVE?" con cache corto en Redis.
 *
 * Uso principal: `JwtStrategy` re-valida en cada request el status de la
 * clínica cuando el token es de impersonation (F1.4.T4). Sin cache iríamos a
 * DB en cada request; con TTL 60 s una suspensión tarda como mucho un minuto
 * en cortar el acceso — y `invalidate()` desde admin lo hace inmediato.
 *
 * Fail-closed respecto a Redis: si Redis falla, se va a DB directo (nunca
 * se asume ACTIVE). Si DB también falla, el error se propaga y el caller
 * decide (la estrategia JWT lo convierte en 401).
 */
@Injectable()
export class ClinicStatusCache {
  private readonly logger = new Logger(ClinicStatusCache.name);
  static readonly TTL_SEC = 60;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  static key(clinicId: string): string {
    return `clinic:status:${clinicId}`;
  }

  async isActive(clinicId: string): Promise<boolean> {
    const key = ClinicStatusCache.key(clinicId);
    let cached: string | null = null;
    try {
      cached = await this.redis.get(key);
    } catch (e) {
      this.logger.warn(
        `clinic status cache GET falló (redis), voy a DB: ${(e as Error).message}`,
      );
    }
    if (cached !== null) return cached === 'ACTIVE';

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { status: true },
    });
    // Clínica inexistente → tratamos como no activa (no cacheamos: no vale
    // la pena y evita cachear ids basura).
    if (!clinic) return false;

    try {
      await this.redis.set(key, clinic.status, 'EX', ClinicStatusCache.TTL_SEC);
    } catch (e) {
      this.logger.warn(
        `clinic status cache SET falló (redis): ${(e as Error).message}`,
      );
    }
    return clinic.status === 'ACTIVE';
  }

  /** Llamar al cambiar `Clinic.status` (suspender / reactivar / archivar). */
  async invalidate(clinicId: string): Promise<void> {
    try {
      await this.redis.del(ClinicStatusCache.key(clinicId));
    } catch (e) {
      // Best-effort: el TTL de 60 s acota la ventana si esto falla.
      this.logger.warn(
        `clinic status cache DEL falló (redis) clinicId=${clinicId}: ${(e as Error).message}`,
      );
    }
  }
}
