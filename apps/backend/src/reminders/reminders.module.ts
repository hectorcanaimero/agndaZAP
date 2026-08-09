import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RemindersService, REMINDERS_QUEUE } from './reminders.service';

/**
 * Parsea REDIS_URL (redis://host:port o redis://user:pass@host:port) al formato
 * { host, port } que consumen BullMQ y ioredis.
 * Default: localhost:6379 (para dev fuera de Docker).
 */
export function parseRedis(): { host: string; port: number } {
  const raw = process.env.REDIS_URL ?? 'redis://localhost:6379';
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || 'localhost',
      port: u.port ? Number.parseInt(u.port, 10) : 6379,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

/**
 * RemindersModule: motor de recordatorios anti no-show.
 *
 * Decisión de DI: RemindersService recibe una `Queue` de bullmq. Proveemos la
 * instancia con `useFactory` usando la CLASE `Queue` como token — así el tipado
 * del constructor de RemindersService (`private readonly queue: Queue`) resuelve
 * por Reflect metadata sin necesidad de `@Inject(TOKEN)`. Como en este módulo
 * solo existe UNA Queue, no hay colisión.
 *
 * La conexión Redis se comparte con el Worker (bootstrap en main.ts) usando el
 * mismo helper `parseRedis()`.
 */
@Module({
  providers: [
    {
      provide: Queue,
      useFactory: (): Queue =>
        new Queue(REMINDERS_QUEUE, { connection: parseRedis() }),
    },
    RemindersService,
  ],
  exports: [RemindersService],
})
export class RemindersModule {}
