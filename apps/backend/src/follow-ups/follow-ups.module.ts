import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { parseRedis } from '../reminders/reminders.module';
import { FollowUpsService, FOLLOW_UPS_QUEUE } from './follow-ups.service';

// FollowUpsModule: motor de satisfacción post-atención (ver ADR 0012).
//
// Mismo patrón de DI que RemindersModule: proveemos la `Queue` con `useFactory`
// usando la CLASE como token — así el constructor de FollowUpsService resuelve
// por Reflect metadata sin `@Inject`. En este módulo hay UNA Queue, no colisiona.
// La conexión Redis se comparte con RemindersModule vía `parseRedis()`.
@Module({
  providers: [
    {
      provide: Queue,
      useFactory: (): Queue =>
        new Queue(FOLLOW_UPS_QUEUE, { connection: parseRedis() }),
    },
    FollowUpsService,
  ],
  exports: [FollowUpsService],
})
export class FollowUpsModule {}
