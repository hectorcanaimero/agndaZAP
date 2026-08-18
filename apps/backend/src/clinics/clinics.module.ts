import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ClinicsController } from './clinics.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ClinicsController],
})
export class ClinicsModule {}
