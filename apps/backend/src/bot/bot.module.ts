import { Module, forwardRef } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PublicModule } from '../public/public.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { BotService } from './bot.service';
import { IntentService } from './intent.service';

/**
 * BotModule: orquestador de conversación (reglas + LLM + FSM de agendamiento).
 * Importa WhatsappModule (WahaService), RemindersModule (RemindersService),
 * SchedulingModule (SchedulingService + AvailabilityService), KnowledgeModule
 * (RAG FAQ para Intent.PREGUNTA_FAQ) y PublicModule (REDIS_CLIENT singleton
 * para el rate-limit por chatId — ver ADR 0007).
 * forwardRef con WhatsappModule para romper el ciclo con WebhookController→BotService.
 */
@Module({
  imports: [
    forwardRef(() => WhatsappModule),
    RemindersModule,
    FollowUpsModule,
    SchedulingModule,
    KnowledgeModule,
    PublicModule,
  ],
  providers: [BotService, IntentService],
  exports: [BotService, IntentService],
})
export class BotModule {}
