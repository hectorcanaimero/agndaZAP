import { Module } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentsController } from './appointments.controller';

@Module({
  imports: [SchedulingModule, RemindersModule, FollowUpsModule],
  controllers: [AppointmentsController],
})
export class AppointmentsModule {}
