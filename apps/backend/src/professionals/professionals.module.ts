import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IcalService } from './ical.service';
import { ProfessionalsController } from './professionals.controller';
import { ProfessionalsIcalController } from './professionals-ical.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ProfessionalsController, ProfessionalsIcalController],
  providers: [IcalService],
  exports: [IcalService],
})
export class ProfessionalsModule {}
