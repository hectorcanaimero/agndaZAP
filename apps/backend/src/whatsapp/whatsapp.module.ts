import { Module, forwardRef } from '@nestjs/common';
import { WahaService } from './waha.service';
import { WebhookController } from './webhook.controller';
import { BotModule } from '../bot/bot.module';

/**
 * WhatsappModule: encapsula el cliente WAHA y el webhook entrante.
 * El WebhookController depende de BotService (importado con forwardRef para
 * evitar el ciclo Whatsapp↔Bot, ya que BotModule también importa WhatsappModule).
 */
@Module({
  imports: [forwardRef(() => BotModule)],
  providers: [WahaService],
  controllers: [WebhookController],
  exports: [WahaService],
})
export class WhatsappModule {}
