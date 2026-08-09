import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { parseRedis } from '../reminders/reminders.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PublicController } from './public.controller';
import { REDIS_CLIENT } from './rate-limit.guard';

/**
 * PublicModule — Bloque 3.
 *
 * Expone la superficie pública (sin auth) para el flujo `/agendar/[clinicSlug]`.
 * Inyecta un `Redis` singleton usado por `RateLimit(N)` (nuestro guard casero).
 *
 * Reusa `parseRedis()` de `RemindersModule` para no duplicar la lógica de parseo
 * de `REDIS_URL`.
 */
@Module({
  imports: [SchedulingModule],
  controllers: [PublicController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis =>
        new Redis({
          ...parseRedis(),
          // Evita que ioredis reintente ad infinitum si Redis está caído en dev.
          // El guard hace fail-open si no hay respuesta.
          maxRetriesPerRequest: 2,
          lazyConnect: false,
        }),
    },
  ],
  // Exportamos REDIS_CLIENT para que AuthModule (u otros) puedan usar `RateLimit(N)`
  // sin duplicar la conexión Redis. Es la misma instancia singleton.
  exports: [REDIS_CLIENT],
})
export class PublicModule {}
