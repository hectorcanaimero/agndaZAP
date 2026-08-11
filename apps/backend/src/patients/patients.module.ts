import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PatientsController } from './patients.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PatientsController],
})
export class PatientsModule {}
