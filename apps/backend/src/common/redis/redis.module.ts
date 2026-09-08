import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { parseRedis } from '../../reminders/reminders.module';
import { REDIS_CLIENT } from '../../public/rate-limit.guard';

/**
 * RedisModule — provider global de un `ioredis` singleton compartido por todo
 * el backend (rate-limit, scheduling-session, cualquier consumidor futuro de
 * caching efímero).
 *
 * ¿Por qué global? El token `REDIS_CLIENT` lo usan módulos que no tienen
 * relación entre sí (PublicModule para rate-limit, SchedulingModule para
 * tokens de sesión pública). Global evita imports cruzados y dependencias
 * circulares. La conexión Redis es UNA SOLA en todo el proceso.
 *
 * Reusa `parseRedis()` de RemindersModule para parsear `REDIS_URL`, así hay
 * una sola verdad sobre el formato de conexión (host/port).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis =>
        new Redis({
          ...parseRedis(),
          // Evita reintentos infinitos si Redis está caído en dev.
          // Consumidores hacen fail-open (rate-limit) o lanzan error explícito
          // (scheduling-session) — la elección es local al caller.
          maxRetriesPerRequest: 2,
          lazyConnect: false,
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
