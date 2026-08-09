import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller';

/**
 * ServicesModule — CRUD de Service del panel.
 * PrismaModule es global, no hace falta importarlo.
 */
@Module({
  controllers: [ServicesController],
})
export class ServicesModule {}
