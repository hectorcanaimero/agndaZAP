import { Module, forwardRef } from '@nestjs/common';
import { PublicModule } from '../public/public.module';
import { WahaService } from './waha.service';
import { WahaHealthMonitor } from './health-monitor.service';
import { WebhookController } from './webhook.controller';
import { WhatsappPanelController } from './whatsapp-panel.controller';
import { BotModule } from '../bot/bot.module';

/**
 * WhatsappModule: encapsula el cliente WAHA, el webhook entrante y el panel
 * de conexión del admin de clínica.
 *
 * `WebhookController` depende de `BotService` — se importa `BotModule` con
 * `forwardRef` para evitar el ciclo Whatsapp↔Bot (BotModule también importa
 * WhatsappModule).
 *
 * `WhatsappPanelController` usa `RateLimit(20, 'waha-status')` que inyecta
 * `REDIS_CLIENT` — se importa `PublicModule` sólo para reusar ese provider
 * singleton (misma conexión Redis que el resto del backend). No expone nada
 * más de PublicModule.
 *
 * `WahaHealthMonitor` es la lógica pura del health-check periódico. Se
 * registra aquí como provider interno; el wiring BullMQ (queue + worker) lo
 * hace T8 y sólo entonces se exportará si otro módulo lo necesita.
 *
 * `PrismaModule` es global (`@Global()`) — no requiere import explícito.
 */
@Module({
  imports: [forwardRef(() => BotModule), PublicModule],
  providers: [WahaService, WahaHealthMonitor],
  controllers: [WebhookController, WhatsappPanelController],
  exports: [WahaService],
})
export class WhatsappModule {}
