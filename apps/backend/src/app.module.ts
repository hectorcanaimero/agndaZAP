import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { RemindersModule } from './reminders/reminders.module';
import { BotModule } from './bot/bot.module';
import { PublicModule } from './public/public.module';
import { AuthModule } from './auth/auth.module';
import { ServicesModule } from './services/services.module';
import { ProfessionalsModule } from './professionals/professionals.module';
import { BusinessHoursModule } from './business-hours/business-hours.module';
import { TimeOffModule } from './time-off/time-off.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { FaqModule } from './faq/faq.module';
import { HealthModule } from './health/health.module';

/**
 * Raíz de la app. La validación global (ValidationPipe) se aplica en main.ts.
 *
 * AuthModule registra `JwtAuthGuard` como APP_GUARD global — todas las rutas
 * quedan protegidas por default salvo las marcadas con `@Public()`.
 *
 * Módulos del Panel (Etapa 1) — CRUDs scoped por tenant vía `TenantContext`:
 * Services, Professionals, BusinessHours, TimeOff, Appointments, Conversations,
 * Dashboard, Faq. Todos protegidos por RolesGuard + tenantWhere en cada query.
 */
@Module({
  imports: [
    PrismaModule,
    WhatsappModule,
    SchedulingModule,
    RemindersModule,
    BotModule,
    PublicModule,
    AuthModule,
    ServicesModule,
    ProfessionalsModule,
    BusinessHoursModule,
    TimeOffModule,
    AppointmentsModule,
    ConversationsModule,
    DashboardModule,
    FaqModule,
    HealthModule,
  ],
})
export class AppModule {}
