import { Module } from '@nestjs/common';
import { TimeOffController } from './time-off.controller';

@Module({
  controllers: [TimeOffController],
})
export class TimeOffModule {}
