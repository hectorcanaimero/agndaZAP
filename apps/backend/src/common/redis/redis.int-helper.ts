import Redis from 'ioredis';

/**
 * Conexión a un Redis REAL para los tests de integración.
 *
 * `REDIS_URL` la inyecta el job de CI (servicio `redis`) y en local apunta al
 * contenedor de `pnpm infra:up`. Si no hay Redis, los tests fallan con un error
 * de conexión claro en vez de colgarse: `maxRetriesPerRequest: 1`.
 */
export function makeIntRedis(): Redis {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    // Sin esto ioredis reintenta indefinidamente y el test se cuelga hasta el
    // timeout, que oculta "no hay Redis" detrás de "el test tardó mucho".
    retryStrategy: (times) => (times > 2 ? null : 100),
  });
}

/**
 * Limpia las claves de un prefijo. Cada suite usa el suyo para que puedan
 * convivir sin pisarse y para no tocar nada que no sea del test.
 *
 * `SCAN` y no `KEYS`: `KEYS` bloquea el servidor, y aunque en CI dé igual, es
 * el tipo de cosa que alguien copia a producción.
 */
export async function flushPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${prefix}*`,
      'COUNT',
      100,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
