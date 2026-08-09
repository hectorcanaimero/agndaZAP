import { Module } from '@nestjs/common';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentsController } from './appointments.controller';

@Module({
  imports: [SchedulingModule, RemindersModule],
  controllers: [AppointmentsController],
})
export class AppointmentsModule {}
