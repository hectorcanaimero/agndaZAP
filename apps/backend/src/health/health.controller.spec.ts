import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

/**
 * Tests del HealthController. Estrategia: mocks manuales, sin `@nestjs/testing`.
 * Cubrimos:
 *  - Happy path: db + redis OK → `{ ok: true }`.
 *  - Redis caído → `{ ok: false, redis: false }` sin tirar 5xx.
 *  - DB caída → `{ ok: false, db: false }` sin tirar 5xx.
 *  - Nunca filtra detalles del error en la respuesta (sólo booleans + timestamp).
 */
describe('HealthController', () => {
  let prisma: any;
  let redis: any;
  let controller: HealthController;

  beforeEach(() => {
    prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    redis = { ping: jest.fn().mockResolvedValue('PONG') };
    controller = new HealthController(
      prisma as unknown as PrismaService,
      redis,
    );
  });

  it('happy path: responde ok=true con db + redis true', async () => {
    const res = await controller.check();
    expect(res.ok).toBe(true);
    expect(res.db).toBe(true);
    expect(res.redis).toBe(true);
    expect(typeof res.timestamp).toBe('string');
    // ISO format: parseable como Date.
    expect(new Date(res.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('redis caído: ok=false, redis=false, sin tirar 5xx', async () => {
    redis.ping.mockRejectedValueOnce(new Error('connection refused'));
    const res = await controller.check();
    expect(res.ok).toBe(false);
    expect(res.db).toBe(true);
    expect(res.redis).toBe(false);
    // El error interno NUNCA se filtra a la respuesta.
    expect(JSON.stringify(res)).not.toContain('connection refused');
  });

  it('db caída: ok=false, db=false, sin tirar 5xx', async () => {
    prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
    const res = await controller.check();
    expect(res.ok).toBe(false);
    expect(res.db).toBe(false);
    expect(res.redis).toBe(true);
    expect(JSON.stringify(res)).not.toContain('db down');
  });

  it('redis PING con respuesta no-PONG → redis=false', async () => {
    redis.ping.mockResolvedValueOnce('MEH');
    const res = await controller.check();
    expect(res.redis).toBe(false);
    expect(res.ok).toBe(false);
  });
});
