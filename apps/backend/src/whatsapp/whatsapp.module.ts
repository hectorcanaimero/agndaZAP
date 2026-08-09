import { Module, forwardRef } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PublicModule } from '../public/public.module';
import { parseRedis } from '../reminders/reminders.module';
import { WahaService } from './waha.service';
import { WahaHealthMonitor } from './health-monitor.service';
import {
  WAHA_HEALTH_QUEUE,
  WAHA_HEALTH_QUEUE_TOKEN,
} from './health-monitor.processor';
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
 * `WahaHealthMonitor` es la lógica pura del health-check periódico. El wiring
 * BullMQ vive en `health-monitor.processor.ts`: aquí registramos la `Queue`
 * bajo `WAHA_HEALTH_QUEUE_TOKEN` (Symbol para no colisionar con la clase
 * `Queue` si el módulo suma otra cola en el futuro) para que `main.ts` la
 * levante y encole el repeatable job. El Worker se crea también en `main.ts`
 * con `createHealthMonitorWorker` para poder cerrarlo en el shutdown handler
 * (mismo patrón que `RemindersWorker`). Reusamos `parseRedis()` del módulo
 * de reminders para no duplicar la lógica de parseo de `REDIS_URL`.
 *
 * Se exporta `WahaHealthMonitor` para que el worker en `main.ts` lo resuelva
 * vía `app.get(WahaHealthMonitor)` sin depender de que el módulo esté abierto
 * de otra forma. Idem `WAHA_HEALTH_QUEUE_TOKEN` (main.ts hace `app.get(...)`).
 *
 * `PrismaModule` es global (`@Global()`) — no requiere import explícito.
 */
@Module({
  imports: [forwardRef(() => BotModule), PublicModule],
  providers: [
    WahaService,
    WahaHealthMonitor,
    {
      provide: WAHA_HEALTH_QUEUE_TOKEN,
      useFactory: (): Queue =>
        new Queue(WAHA_HEALTH_QUEUE, { connection: parseRedis() }),
    },
  ],
  controllers: [WebhookController, WhatsappPanelController],
  exports: [WahaService, WahaHealthMonitor, WAHA_HEALTH_QUEUE_TOKEN],
})
export class WhatsappModule {}
