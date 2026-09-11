import type Redis from 'ioredis';
import { flushPrefix, makeIntRedis } from '../common/redis/redis.int-helper';

/**
 * Dedup de eventos del webhook WAHA contra Redis real.
 *
 * WAHA reintenta el webhook si no recibe 200 a tiempo y puede entregar el mismo
 * mensaje dos veces; sin dedup eso es doble respuesta del bot o doble cita. La
 * garantía depende enteramente de que `SET NX` sea atómico, y eso es justo lo
 * que un mock no puede demostrar: un `Map` en memoria siempre "gana" la carrera
 * porque no hay carrera.
 */
describe('[int] dedup del webhook con SET NX', () => {
  const PREFIX = 'itest:waha:evt:';
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

  async function claim(key: string): Promise<boolean> {
    const res = await redis.set(key, '1', 'EX', 86_400, 'NX');
    return res !== null;
  }

  it('el primer claim gana y el segundo pierde', async () => {
    const key = `${PREFIX}msg-1`;

    expect(await claim(key)).toBe(true);
    expect(await claim(key)).toBe(false);
  });

  it('diez claims concurrentes del mismo id: exactamente UNO gana', async () => {
    // Es la prueba que el mock no puede dar. Con un Map en memoria el
    // resultado es trivialmente correcto porque no hay concurrencia real.
    const key = `${PREFIX}msg-carrera`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => claim(key)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('ids distintos no se pisan', async () => {
    expect(await claim(`${PREFIX}a`)).toBe(true);
    expect(await claim(`${PREFIX}b`)).toBe(true);
  });

  it('liberar la marca permite que el reintento SÍ se procese', async () => {
    // Camino real: el bot lanzó, liberamos la clave y WAHA reintenta.
    const key = `${PREFIX}msg-fallido`;
    await claim(key);

    await redis.del(key);

    expect(await claim(key)).toBe(true);
  });

  it('la marca lleva TTL: no se acumulan claves para siempre', async () => {
    const key = `${PREFIX}msg-ttl`;
    await claim(key);

    const ttl = await redis.ttl(key);

    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it('al expirar, el mismo id vuelve a poder procesarse', async () => {
    const key = `${PREFIX}msg-corto`;
    await redis.set(key, '1', 'PX', 120, 'NX');
    expect(await claim(key)).toBe(false);

    await new Promise((r) => setTimeout(r, 250));

    expect(await claim(key)).toBe(true);
  });
});
