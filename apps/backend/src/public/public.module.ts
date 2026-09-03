import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PublicController } from './public.controller';
import { PublicSchedulingSessionController } from './scheduling-session.controller';

/**
 * PublicModule — Bloque 3.
 *
 * Expone la superficie pública (sin auth) para el flujo `/agendar/[clinicSlug]`.
 * `REDIS_CLIENT` (usado por `RateLimit(N)`) lo provee `RedisModule` global —
 * no duplicamos la conexión ni tenemos que exportar el token acá.
 *
 * Dos controllers:
 *  - `PublicController`                  → `/public/clinics/*` (agenda web).
 *  - `PublicSchedulingSessionController` → `/public/scheduling/session/:token`
 *    (hidrata form desde link mandado por WA).
 */
@Module({
  imports: [SchedulingModule],
  controllers: [PublicController, PublicSchedulingSessionController],
})
export class PublicModule {}
