import { Module } from '@nestjs/common';
import { BusinessHoursController } from './business-hours.controller';

@Module({
  controllers: [BusinessHoursController],
})
export class BusinessHoursModule {}
