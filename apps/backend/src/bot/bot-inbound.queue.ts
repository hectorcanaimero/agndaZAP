import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { parseRedis } from '../reminders/reminders.module';

/** Nombre de la cola de mensajes entrantes de WhatsApp. */
export const BOT_INBOUND_QUEUE = 'bot-inbound';

/**
 * Token propio (Symbol) en vez de la clase `Queue`: `RemindersModule` ya usa
 * `Queue` como token para la cola de recordatorios, así que reutilizarlo daría
 * la cola equivocada a quien la inyecte.
 */
export const BOT_INBOUND_QUEUE_TOKEN = Symbol('BOT_INBOUND_QUEUE');

/** Payload del job. Es lo mismo que recibía `BotService.handleIncoming`. */
export interface BotInboundJobData {
  clinicId: string;
  chatId: string;
  phone: string | null;
  lid: string | null;
  contactName: string | null;
  text: string;
  /**
   * TZ de la clínica, copiada al encolar.
   *
   * Viaja en el job y no se relee en el worker porque los contadores del día
   * dependen de ella: si el worker tiene que consultarla y la base está caída,
   * el contador del error —justo el que avisa del problema— se escribiría con
   * la zona del proceso (UTC) y caería en el día equivocado.
   */
  timezone: string;
  /** Para correlacionar el job con la request del webhook en los logs. */
  requestId?: string;
}

export const BOT_INBOUND_JOB = 'inbound-message';

/**
 * Reintentos del job. El webhook ya respondió 200, así que WAHA no va a
 * reintentar: a partir de aquí la única red es BullMQ. Tres intentos con
 * backoff exponencial cubren un DeepSeek intermitente o un WAHA que tarda,
 * sin castigar al paciente con respuestas repetidas si el fallo es duro.
 */
export const BOT_INBOUND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  // Retención **por edad**, no por cantidad. Un `removeOnComplete: 1000` suena
  // acotado, pero en una clínica de ~100 mensajes/día son diez días del texto
  // de todos los pacientes guardado en Redis: el job lleva el teléfono y el
  // mensaje, o sea datos de salud, y Redis no tiene el cifrado en reposo ni el
  // TLS que el ADR 0004 da por supuestos para Postgres. Con edad, el dato se
  // va solo.
  removeOnComplete: { age: 900, count: 100 },
  // Los fallidos duran más porque son lo que mira el health check y lo que
  // permite entender un incidente, pero un día es de sobra: la ventana del
  // check es de una hora.
  removeOnFail: { age: 86_400, count: 200 },
};

/**
 * Tope del texto que viaja en el job. Simétrico con el truncado del pie de foto
 * en el webhook: sin él, cada request puede meter hasta el límite del
 * body-parser (1 MB) en Redis.
 */
export const MAX_INBOUND_TEXT_CHARS = 4_000;

/**
 * Provee la `Queue` de `bot-inbound` como singleton.
 *
 * Módulo propio porque la necesitan dos sitios que no se importan entre sí:
 * `WhatsappModule` (el webhook, que encola) y `HealthModule` (que cuenta
 * pendientes y fallidos). Registrarla en cada uno crearía dos instancias con
 * dos conexiones a Redis.
 */
@Module({
  providers: [
    {
      provide: BOT_INBOUND_QUEUE_TOKEN,
      useFactory: (): Queue =>
        new Queue(BOT_INBOUND_QUEUE, {
          connection: parseRedis(),
          defaultJobOptions: BOT_INBOUND_JOB_OPTIONS,
        }),
    },
  ],
  exports: [BOT_INBOUND_QUEUE_TOKEN],
})
export class BotInboundQueueModule {}
