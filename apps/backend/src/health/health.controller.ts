import { Controller, Get, HttpCode, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';

// Timeout individual por check en ms. Si un servicio cuelga más que esto,
// se marca como false y NO bloquea la respuesta. Elegido 3s: menor al
// interval de BetterStack (3 min) y suficiente para redes lentas del piloto.
const CHECK_TIMEOUT_MS = 3000;

// En prod NO exponemos el mensaje de error en el response — es un endpoint
// público y un atacante podría inferir versiones o timing de servicios
// caídos. En dev/test sí, útil para debug local. Los errores SIEMPRE se
// loguean con `logger.warn` — Sentry no los captura porque son warn.
const shouldExposeErrorMessage = (): boolean =>
  process.env.NODE_ENV !== 'production';

type CheckResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

type HealthResponse = {
  ok: boolean;
  // Booleans planos para compat con Docker healthcheck actual — deprecar
  // en Q4 cuando migremos el healthcheck a /live.
  db: boolean;
  redis: boolean;
  waha: boolean;
  timestamp: string;
  // Bloque de detalle para debugging manual (latencia por servicio + causa
  // del error). No lo consume el orquestador, solo humanos.
  checks: {
    db: CheckResult;
    redis: CheckResult;
    waha: CheckResult;
  };
};

type LivenessResponse = { ok: true; timestamp: string };

/**
 * Health endpoints públicos (sin auth) para orquestadores.
 *
 * `GET /api/health`      → check completo: db + redis + waha. Latencia p/ each.
 * `GET /api/health/live` → liveness minimal. Sin dependencias. Uso para Docker
 *                           healthcheck y BetterStack "process alive".
 *
 * Todos responden 200 SIEMPRE. El orquestador interpreta el `ok` boolean.
 * Un 500 aquí sería un bug del propio endpoint, no de las dependencias.
 *
 * Cero PII: sólo booleans + latencia + timestamp. Nada del contenido de las
 * dependencias filtra al response.
 */
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly wahaBaseUrl = process.env.WAHA_BASE_URL ?? 'http://localhost:3000';
  private readonly wahaApiKey = process.env.WAHA_API_KEY ?? '';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): LivenessResponse {
    return {
      ok: true,
      timestamp: DateTime.utc().toISO() ?? DateTime.utc().toString(),
    };
  }

  @Get()
  @HttpCode(200)
  async check(): Promise<HealthResponse> {
    // Corremos los 3 checks en paralelo — el peor caso es CHECK_TIMEOUT_MS,
    // no la suma. Con checks secuenciales (3s+3s+3s) el /health tardaría 9s
    // y BetterStack marcaría false por otro motivo.
    const [db, redis, waha] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkWaha(),
    ]);

    return {
      ok: db.ok && redis.ok && waha.ok,
      db: db.ok,
      redis: redis.ok,
      waha: waha.ok,
      timestamp: DateTime.utc().toISO() ?? DateTime.utc().toString(),
      checks: { db, redis, waha },
    };
  }

  private async checkDb(): Promise<CheckResult> {
    const start = Date.now();
    try {
      await this.withTimeout(
        this.prisma.$queryRawUnsafe('SELECT 1'),
        'db',
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`health db check failed: ${msg}`);
      return {
        ok: false,
        latencyMs: Date.now() - start,
        ...(shouldExposeErrorMessage() ? { error: msg } : {}),
      };
    }
  }

  private async checkRedis(): Promise<CheckResult> {
    const start = Date.now();
    try {
      const pong = await this.withTimeout(this.redis.ping(), 'redis');
      return {
        ok: pong === 'PONG',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`health redis check failed: ${msg}`);
      return {
        ok: false,
        latencyMs: Date.now() - start,
        ...(shouldExposeErrorMessage() ? { error: msg } : {}),
      };
    }
  }

  private async checkWaha(): Promise<CheckResult> {
    const start = Date.now();
    try {
      // WAHA 2026.8.1 requiere X-Api-Key en TODOS los endpoints incluidos
      // /health (verificado en logs — 401 sin key). Mandamos la key con
      // header X-Api-Key (misma que usa la app en runtime).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      const res = await fetch(`${this.wahaBaseUrl}/health`, {
        signal: controller.signal,
        headers: this.wahaApiKey ? { 'X-Api-Key': this.wahaApiKey } : {},
      }).finally(() => clearTimeout(timer));
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
        ...(res.ok || !shouldExposeErrorMessage()
          ? {}
          : { error: `HTTP ${res.status}` }),
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`health waha check failed: ${msg}`);
      return {
        ok: false,
        latencyMs: Date.now() - start,
        ...(shouldExposeErrorMessage() ? { error: msg } : {}),
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${name} check timeout ${CHECK_TIMEOUT_MS}ms`)),
          CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
  }
}
