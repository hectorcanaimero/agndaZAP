import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';

/**
 * Sin imports: `REDIS_CLIENT` —que el panel usa para leer los contadores del
 * bot (M9)— lo provee `RedisModule`, que es `@Global()`.
 */
@Module({
  controllers: [DashboardController],
})
export class DashboardModule {}
