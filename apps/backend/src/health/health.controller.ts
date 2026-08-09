import { Controller, Get, HttpCode, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';

/**
 * `GET /api/health` — endpoint público (sin auth) para orquestadores
 * (Docker healthcheck, Uptime Robot, Kubernetes liveness/readiness).
 *
 * Responde SIEMPRE 200 con un JSON que contiene el estado real de dependencias.
 * NO devolvemos 5xx cuando algo falla: el 200+JSON deja al orquestador decidir
 * qué es "unhealthy" y evita que un cliente ingenuo abra un incidente por un
 * blip momentáneo de Redis. Docker/k8s pueden interpretar el JSON con `--spec`
 * o revisar la respuesta con `wget`.
 *
 * Chequeos:
 * - `db`: `SELECT 1` a Postgres (via Prisma raw).
 * - `redis`: `PING`.
 *
 * Cero PII: sólo booleans + timestamp. Nada del contenido de DB o Redis se
 * expone.
 */
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @HttpCode(200)
  async check(): Promise<{
    ok: boolean;
    db: boolean;
    redis: boolean;
    timestamp: string;
  }> {
    let dbOk = false;
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      dbOk = true;
    } catch (e) {
      this.logger.warn(`health db check failed: ${(e as Error).message}`);
    }

    let redisOk = false;
    try {
      const pong = await this.redis.ping();
      redisOk = pong === 'PONG';
    } catch (e) {
      this.logger.warn(`health redis check failed: ${(e as Error).message}`);
    }

    return {
      ok: dbOk && redisOk,
      db: dbOk,
      redis: redisOk,
      // Timestamp UTC (Luxon en vez de `new Date()`, respetando la convención
      // del repo). El orquestador que consume esto es TZ-agnóstico.
      timestamp: DateTime.utc().toISO() ?? DateTime.utc().toString(),
    };
  }
}
