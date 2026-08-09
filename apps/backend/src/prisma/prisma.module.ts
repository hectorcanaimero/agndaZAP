import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * PrismaModule global: expone PrismaService a toda la app sin necesidad de
 * reimportarlo en cada módulo. Necesario porque prácticamente todo depende de él.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
