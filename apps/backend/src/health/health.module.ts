import { Module } from '@nestjs/common';
import { PublicModule } from '../public/public.module';
import { HealthController } from './health.controller';

/**
 * HealthModule expone `GET /api/health`. Depende de PrismaModule (global) para
 * el chequeo de DB y de `REDIS_CLIENT` (exportado por PublicModule) para el
 * chequeo de Redis. Reutiliza la instancia singleton de Redis — no abre una
 * conexión extra.
 */
@Module({
  imports: [PublicModule],
  controllers: [HealthController],
})
export class HealthModule {}
