import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  mixin,
  Type,
} from '@nestjs/common';
import Redis from 'ioredis';
import { extractIp, MinimalRequest } from '../common/extract-ip';

/**
 * Tipos mínimos del response que usamos. Evitamos la dep `@types/express`
 * porque Nest ya provee la interoperabilidad y nuestro uso es acotado.
 */
interface MinimalResponse {
  setHeader?: (name: string, value: string) => void;
}

// Re-export para compat con imports existentes (auth módulo, tests).
export { extractIp } from '../common/extract-ip';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Fábrica de guards Nest para rate-limit basado en Redis.
 *
 * Estrategia: **fixed window por IP + slug** con bucket de 60 segundos.
 * Clave Redis: `ratelimit:{slug}:{ip}:{minuteBucket}`.
 *
 * Implementación atómica con `INCR` + `EXPIRE`:
 * - `INCR` devuelve el nuevo contador (crea la clave si no existe con valor 1).
 * - En la PRIMERA request de la ventana, seteamos `EXPIRE 60` para que la clave
 *   se limpie sola (así no hay que hacer housekeeping ni SCAN).
 * - Si `count > limit` → 429 con `Retry-After: 60`.
 *
 * ¿Por qué NO `@nestjs/throttler`?
 * - Añade una dep + su propio storage abstracto.
 * - Su default in-memory no sirve multi-instancia; con Redis storage añade
 *   otra dep más (`@nest-lab/throttler-storage-redis`).
 * - Nuestro caso es un endpoint público único; el guard casero cabe en < 60
 *   líneas y usa el mismo `ioredis` que el resto del backend.
 * - Menos superficie de dependencias = menos CVEs y menos boot time.
 *
 * ¿Por qué fixed window y no sliding?
 * - Fixed window es 1 comando Redis (INCR) + a veces EXPIRE. Barato.
 * - Sliding requiere sorted sets con ZADD/ZREMRANGEBYSCORE por request — más
 *   caro y con menor beneficio para un umbral chico (5/min o 30/min).
 * - El "burst" al filo de la ventana (10 en 61s peor caso) es aceptable para
 *   este caso: al fin y al cabo la protección real anti-doble-reserva la da
 *   `@@unique([professionalId, startAt])` en Postgres.
 *
 * Sobre la IP:
 * - Sin proxy confiable delante del backend → dejamos `TRUST_PROXY` sin setear
 *   (o `false`) y usamos `req.ip`. Cualquier `X-Forwarded-For` es ignorado
 *   (defensa contra spoofing del header desde el cliente).
 * - Detrás de Cloudflare/nginx/ALB → setear `TRUST_PROXY=true`. Sólo entonces
 *   confiamos en el header y tomamos la primera IP (la del cliente original).
 */
export function RateLimit(
  limit: number,
  scope?: string,
): Type<CanActivate> {
  @Injectable()
  class RateLimitGuardMixin implements CanActivate {
    private readonly logger = new Logger('RateLimitGuard');
    private readonly trustProxy = process.env.TRUST_PROXY === 'true';

    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const http = context.switchToHttp();
      const req = http.getRequest<MinimalRequest>();
      const res = http.getResponse<MinimalResponse>();
      // Determinación de la "dimensión" de la clave Redis:
      // - Si el decorator recibió `scope` explícito (ej: 'auth-login'), lo
      //   usamos como namespace de la key. Independiza el rate-limit de la
      //   ruta y evita colisiones cross-tenant.
      // - Si no, caemos al `slug` del path (rutas públicas con :slug).
      // - Si tampoco hay slug, usamos `'default'` (nunca `'unknown'` porque
      //   quisimos evitar el bucket compartido implícito).
      const key1 =
        scope ??
        (req.params?.slug as string | undefined) ??
        'default';
      const ip = extractIp(req, this.trustProxy);

      // Bucket de 60s. Dos requests dentro del mismo minuto caen a la misma
      // clave; al pasar a otro minuto entramos a un bucket nuevo (con TTL fresco).
      const bucket = Math.floor(Date.now() / 60_000);
      const key = `ratelimit:${key1}:${ip}:${bucket}`;

      // INCR + EXPIRE (sólo la primera vez) via pipeline; no hace falta LUA
      // para este nivel de garantía — un doble-EXPIRE no cambia el resultado.
      const pipeline = this.redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, 60);
      const results = await pipeline.exec();

      if (!results) {
        // Redis down: fail-open sería inseguro (podríamos ser DDoS'd). Fail-closed
        // sería DoS a nosotros mismos. Elegimos fail-open pero LOGUEAMOS a error
        // para alertar. El endpoint de todas formas tiene el constraint DB detrás.
        this.logger.error(`rate-limit falló (redis) para key=${key1}`);
        return true;
      }

      const [incrErr, count] = results[0] ?? [null, 0];
      if (incrErr) {
        this.logger.error(`rate-limit INCR error: ${incrErr.message}`);
        return true;
      }

      const currentCount = typeof count === 'number' ? count : Number(count);
      if (currentCount > limit) {
        // Cero PII en logs: IP + scope/slug + status. NUNCA phone/name/notes.
        this.logger.warn(
          `rate-limit HIT key=${key1} ip=${ip} count=${currentCount} limit=${limit}`,
        );
        // Setear el header ANTES de tirar la excepción; Nest lo respeta al
        // serializar la respuesta 429.
        res.setHeader?.('Retry-After', '60');
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'demasiadas solicitudes',
            retryAfter: 60,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    }
  }

  return mixin(RateLimitGuardMixin);
}
