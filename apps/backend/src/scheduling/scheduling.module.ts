import { Module } from '@nestjs/common';
import { RemindersModule } from '../reminders/reminders.module';
import { AvailabilityService } from './availability.service';
import { SchedulingService } from './scheduling.service';

/**
 * SchedulingModule: motor de disponibilidad + creación de citas.
 * Depende de PrismaService (global) y de RemindersService (para programar
 * jobs al crear una cita). Exporta ambos services porque los consumen tanto
 * el BotModule (FSM) como el endpoint público (Bloque 3).
 */
@Module({
  imports: [RemindersModule],
  providers: [AvailabilityService, SchedulingService],
  exports: [AvailabilityService, SchedulingService],
})
export class SchedulingModule {}
