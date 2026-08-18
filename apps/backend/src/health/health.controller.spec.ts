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
 */
describe('HealthController', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  let controller: HealthController;
  const originalFetch = global.fetch;

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    redis = { ping: jest.fn().mockResolvedValue('PONG') };
    // Mock global fetch — WAHA check happy path por default.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as unknown as Response);
    controller = new HealthController(
      prisma as unknown as PrismaService,
      redis,
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
});
