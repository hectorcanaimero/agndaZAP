import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

/**
 * Tests del HealthController. Estrategia: mocks manuales, sin `@nestjs/testing`.
 * Cubrimos:
 *  - Happy path: db + redis + waha OK → `{ ok: true }`.
 *  - Cada dependencia caída → `{ ok: false, <dep>: false }` sin tirar 5xx.
 *  - `/live` responde siempre 200.
 *  - Timeout por check (redis lento → false, no cuelga el response).
 *  - En prod NO expone error messages en el response (anti-recon).
 *  - Profundidad de la cola `bot-inbound` (B10).
 */
describe('HealthController', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let botInbound: any;
  let controller: HealthController;
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    setContext: jest.fn(),
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    redis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      // Los fallidos se cuentan con ZCOUNT sobre el zset, no trayendo jobs.
      zcount: jest.fn().mockResolvedValue(0),
    };
    // Mock global fetch — WAHA check happy path por default.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as unknown as Response);
    botInbound = {
      getWaitingCount: jest.fn().mockResolvedValue(0),
      getWaiting: jest.fn().mockResolvedValue([]),
    };
    logger.warn.mockClear();
    logger.error.mockClear();
    controller = new HealthController(
      prisma as unknown as PrismaService,
      redis,
      botInbound as unknown as Queue,
      logger as never,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('/live', () => {
    it('siempre devuelve ok:true sin tocar dependencias', () => {
      const res = controller.live();
      expect(res.ok).toBe(true);
      expect(typeof res.timestamp).toBe('string');
      expect(new Date(res.timestamp).toString()).not.toBe('Invalid Date');
      // Cero interacción con prisma/redis/fetch.
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(redis.ping).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('/health (check completo)', () => {
    it('happy path: ok=true con db + redis + waha true + latencia', async () => {
      const res = await controller.check();
      expect(res.ok).toBe(true);
      expect(res.db).toBe(true);
      expect(res.redis).toBe(true);
      expect(res.waha).toBe(true);
      expect(res.checks.db.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.checks.redis.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.checks.waha.latencyMs).toBeGreaterThanOrEqual(0);
      expect(new Date(res.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('redis caído: ok=false, redis=false, sigue devolviendo 200 con detalle', async () => {
      redis.ping.mockRejectedValueOnce(new Error('connection refused'));
      const res = await controller.check();
      expect(res.ok).toBe(false);
      expect(res.db).toBe(true);
      expect(res.redis).toBe(false);
      expect(res.waha).toBe(true);
      // En test/dev sí exponemos el mensaje para debug.
      expect(res.checks.redis.error).toBe('connection refused');
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'health redis check failed',
      );
    });

    it('db caída: ok=false, db=false', async () => {
      prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
      const res = await controller.check();
      expect(res.ok).toBe(false);
      expect(res.db).toBe(false);
      expect(res.redis).toBe(true);
      expect(res.checks.db.error).toBe('db down');
    });

    it('waha down (HTTP 500): ok=false, waha=false, error=HTTP 500', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);
      const res = await controller.check();
      expect(res.ok).toBe(false);
      expect(res.waha).toBe(false);
      expect(res.checks.waha.error).toBe('HTTP 500');
    });

    it('waha unreachable (fetch throw): ok=false, waha=false', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await controller.check();
      expect(res.ok).toBe(false);
      expect(res.waha).toBe(false);
      expect(res.checks.waha.error).toContain('ECONNREFUSED');
    });

    it('redis PING con respuesta no-PONG → redis=false, ok=false', async () => {
      redis.ping.mockResolvedValueOnce('MEH');
      const res = await controller.check();
      expect(res.redis).toBe(false);
      expect(res.ok).toBe(false);
    });

    it('en producción NO expone mensajes de error (anti-recon)', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        redis.ping.mockRejectedValueOnce(new Error('connection refused'));
        prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
        global.fetch = jest
          .fn()
          .mockRejectedValue(new Error('waha unreachable'));
        const res = await controller.check();
        expect(res.ok).toBe(false);
        expect(res.checks.db.error).toBeUndefined();
        expect(res.checks.redis.error).toBeUndefined();
        expect(res.checks.waha.error).toBeUndefined();
        // Los booleans + latencia siguen presentes.
        expect(res.checks.db.ok).toBe(false);
        expect(res.checks.db.latencyMs).toBeGreaterThanOrEqual(0);
        // Y el response completo NO contiene los strings de error.
        expect(JSON.stringify(res)).not.toContain('connection refused');
        expect(JSON.stringify(res)).not.toContain('db down');
        expect(JSON.stringify(res)).not.toContain('waha unreachable');
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it('los 3 checks corren en paralelo (no serial)', async () => {
      // Simulamos que cada check tarda 50ms. Serial = 150ms, paralelo = ~50ms.
      prisma.$queryRawUnsafe.mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r([{}]), 50)),
      );
      redis.ping.mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r('PONG'), 50)),
      );
      global.fetch = jest.fn().mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(() => r({ ok: true, status: 200 } as Response), 50),
          ),
      );
      const start = Date.now();
      await controller.check();
      const elapsed = Date.now() - start;
      // Con paralelismo real deberíamos estar cerca de 50ms + overhead.
      // Damos margen generoso: <120ms es señal clara de paralelismo.
      expect(elapsed).toBeLessThan(120);
    });
  });

  /**
   * B10: la cola entre el webhook y el bot convierte un fallo ruidoso (500 →
   * WAHA reintenta) en uno silencioso. Si el worker muere, los mensajes se
   * apilan y el paciente no recibe nada; este check es lo que lo hace visible.
   */
  describe('cola bot-inbound', () => {
    it('cola vacía: ok y expone los contadores', async () => {
      const res = await controller.check();
      expect(res.ok).toBe(true);
      expect(res.checks.botInbound).toMatchObject({
        ok: true,
        waiting: 0,
        failedLastHour: 0,
      });
    });

    it('más de 50 esperando → degradado y log de error', async () => {
      botInbound.getWaitingCount.mockResolvedValue(51);
      const res = await controller.check();

      expect(res.ok).toBe(false);
      expect(res.checks.botInbound.ok).toBe(false);
      expect(res.checks.botInbound.waiting).toBe(51);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ waiting: 51 }),
        expect.stringContaining('bot-inbound'),
      );
    });

    it('exactamente 50 esperando todavía es ok (el umbral no se pasa)', async () => {
      botInbound.getWaitingCount.mockResolvedValue(50);
      const res = await controller.check();
      expect(res.checks.botInbound.ok).toBe(true);
    });

    /**
     * Un fallo suelto se reporta y se loguea, pero NO tumba el `ok`: este
     * endpoint es público, y si un mensaje concreto revienta el bot bastaría
     * repetirlo para mantener el backend "degradado" una hora entera, gratis.
     */
    it('un fallo definitivo se reporta y loguea, pero no tumba el ok', async () => {
      redis.zcount.mockResolvedValue(1);
      const res = await controller.check();

      expect(res.ok).toBe(true);
      expect(res.checks.botInbound.failedLastHour).toBe(1);
      expect(logger.error).toHaveBeenCalled();
    });

    it('cuenta los fallidos con ZCOUNT sobre la ventana de una hora', async () => {
      await controller.check();
      const [key, min] = redis.zcount.mock.calls[0];
      expect(key).toBe('bull:bot-inbound:failed');
      expect(min).toBeGreaterThan(Date.now() - 3_700_000);
    });

    it('NO trae los jobs fallidos: llevan el texto del paciente', async () => {
      await controller.check();
      expect(botInbound.getFailed).toBeUndefined();
    });

    /**
     * La profundidad sola no detecta un worker muerto: una clínica con 5-10
     * mensajes/hora tardaría días en juntar 51 pendientes y el health estaría
     * verde todo ese tiempo sin que nadie reciba respuesta.
     */
    it('un mensaje viejo esperando degrada aunque haya pocos pendientes', async () => {
      botInbound.getWaitingCount.mockResolvedValue(3);
      botInbound.getWaiting.mockResolvedValue([
        { timestamp: Date.now() - 300_000 },
      ]);
      const res = await controller.check();

      expect(res.ok).toBe(false);
      expect(res.checks.botInbound.oldestWaitingS).toBeGreaterThanOrEqual(300);
    });

    it('un mensaje recién encolado no degrada nada', async () => {
      botInbound.getWaitingCount.mockResolvedValue(3);
      botInbound.getWaiting.mockResolvedValue([
        { timestamp: Date.now() - 5_000 },
      ]);
      const res = await controller.check();
      expect(res.ok).toBe(true);
    });

    it('sólo mira el primero de la cola, no la lista entera', async () => {
      await controller.check();
      expect(botInbound.getWaiting).toHaveBeenCalledWith(0, 0);
    });

    it('cola sana: no loguea error (un falso positivo aquí despierta a alguien)', async () => {
      await controller.check();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('si no se puede consultar la cola NO se declara degradado el sistema', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      // Fail-open: el check de Redis ya cubre esa causa raíz; no vamos a poner
      // el health en rojo por no poder mirar.
      botInbound.getWaitingCount.mockRejectedValue(new Error('redis down'));
      const res = await controller.check();

      expect(res.checks.botInbound.ok).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('no sube a los booleanos planos de compat', async () => {
      botInbound.getWaitingCount.mockResolvedValue(999);
      const res = await controller.check();
      // `ok` sí lo refleja; db/redis/waha siguen siendo lo que son.
      expect(res.ok).toBe(false);
      expect(res.db).toBe(true);
      expect(res.redis).toBe(true);
      expect(res.waha).toBe(true);
    });
  });
});
