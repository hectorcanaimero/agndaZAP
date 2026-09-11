import type Redis from 'ioredis';
import { flushPrefix, makeIntRedis } from '../common/redis/redis.int-helper';

/**
 * Rate-limit de ventana fija contra Redis real.
 *
 * El guard cuenta con `INCR` + `EXPIRE` sobre una clave por minuto. Lo que un
 * mock no puede demostrar es que `INCR` sea atómico bajo concurrencia — que es
 * precisamente la situación en la que un rate-limit tiene que funcionar.
 */
describe('[int] rate-limit con INCR + EXPIRE', () => {
  const PREFIX = 'itest:ratelimit:';
  let redis: Redis;

  beforeAll(() => {
    redis = makeIntRedis();
  });

  beforeEach(async () => {
    await flushPrefix(redis, PREFIX);
  });

  afterAll(async () => {
    await flushPrefix(redis, PREFIX);
    await redis.quit();
  });

  /** Réplica de lo que hace el guard, para ejercitar la semántica de Redis. */
  async function hit(key: string): Promise<number> {
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 60);
    const res = await pipeline.exec();
    return Number(res?.[0]?.[1] ?? 0);
  }

  it('cuenta correctamente los hits secuenciales', async () => {
    const key = `${PREFIX}seq`;

    expect(await hit(key)).toBe(1);
    expect(await hit(key)).toBe(2);
    expect(await hit(key)).toBe(3);
  });

  it('50 hits concurrentes cuentan exactamente 50: no se pierde ninguno', async () => {
    // Un contador no atómico daría menos por lost updates, y el rate-limit
    // dejaría pasar tráfico en silencio justo bajo carga, que es cuando importa.
    const key = `${PREFIX}carrera`;

    const counts = await Promise.all(
      Array.from({ length: 50 }, () => hit(key)),
    );

    expect(Math.max(...counts)).toBe(50);
    expect(new Set(counts).size).toBe(50); // sin valores repetidos
  });

  it('claves distintas no comparten cubo', async () => {
    // Es el bug que ya se coló una vez: los GET consumían el cupo del POST y
    // el paciente comía un 429 al confirmar la cita.
    await hit(`${PREFIX}scope-a:demo:1.2.3.4:100`);
    await hit(`${PREFIX}scope-a:demo:1.2.3.4:100`);

    expect(await hit(`${PREFIX}scope-b:demo:1.2.3.4:100`)).toBe(1);
  });

  it('la clave caduca sola: no hay housekeeping que mantener', async () => {
    const key = `${PREFIX}ttl`;
    await hit(key);

    const ttl = await redis.ttl(key);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('al cambiar de ventana el contador arranca de cero', async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    await hit(`${PREFIX}ventana:${bucket}`);
    await hit(`${PREFIX}ventana:${bucket}`);

    expect(await hit(`${PREFIX}ventana:${bucket + 1}`)).toBe(1);
  });
});
