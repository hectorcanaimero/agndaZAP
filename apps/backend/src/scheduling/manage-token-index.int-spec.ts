import type Redis from 'ioredis';
import { flushPrefix, makeIntRedis } from '../common/redis/redis.int-helper';

/**
 * Índice `appointmentId → tokens de gestión` contra Redis real.
 *
 * Esta suite existe por un fallo concreto: al escribir los tests unitarios del
 * índice, el mock de `del` solo borraba claves de tipo string, así que el test
 * de "borra también el índice" pasaba sin que el índice —un SET— se borrara. El
 * `DEL` real borra la clave sea del tipo que sea. El mock confirmaba lo que yo
 * creía en vez de lo que Redis hace.
 *
 * Lo que se prueba acá es la mezcla de tipos (string + set), que es justo donde
 * un mock casero se desvía.
 */
describe('[int] índice de tokens de gestión', () => {
  const TOKEN_PREFIX = 'itest:sched:manage:';
  const INDEX_PREFIX = 'itest:sched:manage:appt:';
  let redis: Redis;

  beforeAll(() => {
    redis = makeIntRedis();
  });

  beforeEach(async () => {
    await flushPrefix(redis, TOKEN_PREFIX);
  });

  afterAll(async () => {
    await flushPrefix(redis, TOKEN_PREFIX);
    await redis.quit();
  });

  async function emit(apptId: string, token: string) {
    await redis.set(TOKEN_PREFIX + token, JSON.stringify({ apptId }), 'EX', 3600);
    await redis.sadd(INDEX_PREFIX + apptId, token);
    await redis.expire(INDEX_PREFIX + apptId, 2_592_000);
  }

  async function invalidateAll(apptId: string): Promise<number> {
    const indexKey = INDEX_PREFIX + apptId;
    const tokens = await redis.smembers(indexKey);
    if (tokens.length === 0) {
      await redis.del(indexKey);
      return 0;
    }
    await redis.del(...tokens.map((t) => TOKEN_PREFIX + t), indexKey);
    return tokens.length;
  }

  it('un solo DEL borra los tokens (strings) Y el índice (set)', async () => {
    // El caso que el mock no cubría: DEL sobre tipos mezclados en una llamada.
    await emit('appt-1', 'tok-a');
    await emit('appt-1', 'tok-b');

    const n = await invalidateAll('appt-1');

    expect(n).toBe(2);
    expect(await redis.get(`${TOKEN_PREFIX}tok-a`)).toBeNull();
    expect(await redis.get(`${TOKEN_PREFIX}tok-b`)).toBeNull();
    expect(await redis.exists(`${INDEX_PREFIX}appt-1`)).toBe(0);
  });

  it('no toca los tokens de otra cita', async () => {
    await emit('appt-1', 'tok-mia');
    await emit('appt-2', 'tok-ajena');

    await invalidateAll('appt-1');

    expect(await redis.get(`${TOKEN_PREFIX}tok-ajena`)).not.toBeNull();
  });

  it('el índice es un SET: emitir el mismo token dos veces no lo duplica', async () => {
    await emit('appt-1', 'tok-a');
    await emit('appt-1', 'tok-a');

    expect(await redis.scard(`${INDEX_PREFIX}appt-1`)).toBe(1);
  });

  it('una cita sin tokens no es un error', async () => {
    expect(await invalidateAll('appt-sin-links')).toBe(0);
  });

  it('el índice vive más que los tokens que contiene', async () => {
    // Si caducara antes, quedarían tokens vivos sin forma de revocarlos: justo
    // lo que el índice viene a evitar.
    await emit('appt-1', 'tok-a');

    const ttlToken = await redis.ttl(`${TOKEN_PREFIX}tok-a`);
    const ttlIndice = await redis.ttl(`${INDEX_PREFIX}appt-1`);

    expect(ttlIndice).toBeGreaterThan(ttlToken);
  });
});
