import { Module } from '@nestjs/common';
import { RemindersModule } from '../reminders/reminders.module';
import { AvailabilityService } from './availability.service';
import { SchedulingSessionService } from './scheduling-session.service';
import { SchedulingService } from './scheduling.service';

/**
 * SchedulingModule: motor de disponibilidad + creación de citas + tokens de
 * sesión de agendamiento web (linkeo WA↔web).
 *
 * Depende de PrismaService (global), RedisModule (global — para
 * SchedulingSessionService) y RemindersService (para programar jobs al crear
 * una cita).
 *
 * Exporta los tres services porque los consumen tanto el BotModule (FSM,
 * creación de links) como el endpoint público (Bloque 3).
 */
@Module({
  imports: [RemindersModule],
  providers: [AvailabilityService, SchedulingService, SchedulingSessionService],
  exports: [AvailabilityService, SchedulingService, SchedulingSessionService],
})
export class SchedulingModule {}
