import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  BOT_INBOUND_QUEUE,
  BOT_INBOUND_QUEUE_TOKEN,
} from '../bot/bot-inbound.queue';
import { DateTime } from 'luxon';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../public/rate-limit.guard';

// Timeout individual por check en ms. Si un servicio cuelga más que esto,
// se marca como false y NO bloquea la respuesta. Elegido 3s: menor al
// interval de BetterStack (3 min) y suficiente para redes lentas del piloto.
/** Exportado para que el test del timeout no lo duplique y se desincronice. */
export const CHECK_TIMEOUT_MS = 3000;

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

/** Profundidad de la cola de mensajes entrantes. Ver `checkBotInbound`. */
type QueueCheckResult = CheckResult & {
  waiting?: number;
  failedLastHour?: number;
  /** Antigüedad del mensaje más viejo sin procesar, en segundos. */
  oldestWaitingS?: number;
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
    /**
     * No sube a los booleanos planos de arriba: ésos son la superficie de
     * compat con el healthcheck de Docker y están marcados para deprecar. Sí
     * cuenta para `ok`, que es lo que mira un humano o un monitor.
     */
    botInbound: QueueCheckResult;
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
  /** Pendientes a partir de los cuales la cola se considera degradada. */
  private static readonly MAX_WAITING = 50;

  /**
   * Antigüedad máxima del mensaje más viejo sin procesar.
   *
   * Es la señal que de verdad detecta un worker muerto. La profundidad sola no
   * sirve: una clínica piloto con 5-10 mensajes/hora tardaría **días** en
   * acumular 51 pendientes, y el health estaría en verde todo ese tiempo
   * mientras ningún paciente recibe respuesta.
   */
  private static readonly MAX_WAITING_AGE_S = 120;

  private readonly wahaBaseUrl =
    process.env.WAHA_BASE_URL ?? 'http://localhost:3000';
  private readonly wahaApiKey = process.env.WAHA_API_KEY ?? '';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(BOT_INBOUND_QUEUE_TOKEN) private readonly botInbound: Queue,
    @InjectPinoLogger() private readonly logger: PinoLogger,
  ) {
    // `@InjectPinoLogger(nombre)` exige el provider `PinoLogger:HealthController`,
    // que nestjs-pino sólo crea si la clase decorada se cargó antes de
    // `LoggerModule.forRoot`; en prod no ocurre y Nest no arranca. Mismo
    // patrón que AuthController/AppointmentsController: setContext en el ctor.
    this.logger.setContext(HealthController.name);
  }

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
    // Corremos los checks en paralelo — el peor caso es CHECK_TIMEOUT_MS, no
    // la suma. Con checks secuenciales (3s+3s+3s) el /health tardaría 9s y
    // BetterStack marcaría false por otro motivo.
    const [db, redis, waha, botInbound] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkWaha(),
      this.checkBotInbound(),
    ]);

    return {
      ok: db.ok && redis.ok && waha.ok && botInbound.ok,
      // `botInbound.ok` sólo mira la profundidad de la cola, nunca los fallos
      // sueltos: ver `checkBotInbound`.
      db: db.ok,
      redis: redis.ok,
      waha: waha.ok,
      timestamp: DateTime.utc().toISO() ?? DateTime.utc().toString(),
      checks: { db, redis, waha, botInbound },
    };
  }

  /**
   * Profundidad de la cola `bot-inbound`.
   *
   * Por qué existe: al meter la cola entre el webhook y el bot, un fallo dejó
   * de ser ruidoso. Antes, si el bot se caía el webhook devolvía 500 y WAHA
   * reintentaba; ahora el webhook responde 200 igualmente y, si el worker está
   * muerto, los mensajes se apilan **en silencio** y el paciente simplemente no
   * recibe respuesta. Esto es lo que lo hace visible.
   *
   * Degradado si hay demasiados pendientes **o** si el más viejo lleva
   * demasiado esperando. Las dos señales son distintas: la profundidad detecta
   * un pico, la antigüedad detecta un worker muerto con poco tráfico.
   *
   * Los fallos definitivos se cuentan y se loguean, pero NO tumban el `ok`.
   * Este endpoint es público y lo mira un monitor: si un mensaje concreto
   * revienta el bot, bastaría repetirlo para mantener el backend "degradado"
   * una hora entera, gratis. Un paciente sin respuesta es un problema
   * operativo que hay que ver en los logs, no un fallo de liveness.
   *
   * Fail-open: si no podemos consultar la cola, no declaramos degradado el
   * sistema por no poder mirar. El check de Redis ya cubre esa causa.
   */
  private async checkBotInbound(): Promise<QueueCheckResult> {
    const start = Date.now();
    try {
      const [waiting, failedLastHour, oldestWaitingS] = await this.withTimeout(
        Promise.all([
          this.botInbound.getWaitingCount(),
          this.recentFailures(),
          this.oldestWaitingAgeS(),
        ]),
        'bot-inbound',
      );

      const ok =
        waiting <= HealthController.MAX_WAITING &&
        oldestWaitingS <= HealthController.MAX_WAITING_AGE_S;
      if (!ok || failedLastHour > 0) {
        // A nivel `error` a propósito: significa pacientes esperando una
        // respuesta que no llega, y es lo que queremos que dispare una alerta.
        this.logger.error(
          { waiting, failedLastHour, oldestWaitingS },
          'cola bot-inbound degradada — mensajes de pacientes sin procesar',
        );
      }
      return {
        ok,
        latencyMs: Date.now() - start,
        waiting,
        failedLastHour,
        oldestWaitingS,
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn({ err }, 'health bot-inbound check failed');
      return {
        ok: true,
        latencyMs: Date.now() - start,
        ...(shouldExposeErrorMessage() ? { error: msg } : {}),
      };
    }
  }

  /**
   * Jobs que agotaron sus reintentos en la última hora.
   *
   * `ZCOUNT` sobre el zset de fallidos, no `getFailed()`: éste hace un HGETALL
   * por job y traería el `data` completo — hasta cientos de mensajes de
   * pacientes cargados en memoria **en cada ping anónimo a /api/health**. El
   * zset tiene el timestamp de finalización como score, así que el rango da el
   * número sin tocar el contenido.
   *
   * `getFailedCount()` tampoco sirve: cuenta todo lo retenido, así que un fallo
   * de ayer dejaría el contador alto todo el día.
   */
  /**
   * Segundos que lleva esperando el mensaje más viejo, o 0 si no hay ninguno.
   *
   * Un solo job, no la lista entera: `getWaiting(0, 0)` trae el primero de una
   * cola FIFO. Trae su `data` (con el texto del paciente), así que sólo se lee
   * el `timestamp` y no se loguea nada más.
   */
  private async oldestWaitingAgeS(): Promise<number> {
    const [oldest] = await this.botInbound.getWaiting(0, 0);
    if (!oldest?.timestamp) return 0;
    return Math.max(0, Math.round((Date.now() - oldest.timestamp) / 1000));
  }

  private async recentFailures(): Promise<number> {
    const since = Date.now() - 3_600_000;
    const key = `bull:${BOT_INBOUND_QUEUE}:failed`;
    const count = await this.redis.zcount(key, since, '+inf');
    return Number(count) || 0;
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
      this.logger.warn({ err }, 'health db check failed');
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
      this.logger.warn({ err }, 'health redis check failed');
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
      this.logger.warn({ err }, 'health waha check failed');
      return {
        ok: false,
        latencyMs: Date.now() - start,
        ...(shouldExposeErrorMessage() ? { error: msg } : {}),
      };
    }
  }

  private async withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`${name} check timeout ${CHECK_TIMEOUT_MS}ms`)),
            CHECK_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
