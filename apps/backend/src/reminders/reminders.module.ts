import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RemindersService, REMINDERS_QUEUE } from './reminders.service';

/**
 * Parsea REDIS_URL (redis://host:port o redis://user:pass@host:port) al formato
 * { host, port } que consumen BullMQ y ioredis.
 * Default: localhost:6379 (para dev fuera de Docker).
 */
export type RedisConnection = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
};

/**
 * Hasta B10, esta función tiraba usuario, contraseña y esquema `rediss://` del
 * `REDIS_URL`: daba igual porque en Redis sólo había contadores, hashes de
 * dedup e IDs. La cola `bot-inbound` es la primera que mete datos del paciente,
 * así que las credenciales y el TLS del URL tienen que llegar al cliente.
 */
export function parseRedis(): RedisConnection {
  const raw = process.env.REDIS_URL ?? 'redis://localhost:6379';
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || 'localhost',
      port: u.port ? Number.parseInt(u.port, 10) : 6379,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      // `rediss://` → TLS. Objeto vacío = opciones por defecto de Node.
      ...(u.protocol === 'rediss:' ? { tls: {} as Record<string, never> } : {}),
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
