import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentsController } from './appointments.controller';

// Ver PatientsModule para la justificación de LoggerModule.forFeature.
@Module({
  imports: [
    SchedulingModule,
    RemindersModule,
    FollowUpsModule,
    LoggerModule.forFeature([{ name: AppointmentsController.name }]),
  ],
  controllers: [AppointmentsController],
})
export class AppointmentsModule {}
