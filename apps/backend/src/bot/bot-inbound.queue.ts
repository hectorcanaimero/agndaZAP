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
  /**
   * Nota de voz pendiente de transcribir (M10). Cuando viene, `text` llega
   * vacío y lo rellena el worker con la transcripción.
   *
   * La URL **caduca a los 900 s** (`WHATSAPP_FILES_LIFETIME` de WAHA), así que
   * este job corre con prioridad y backoff corto: ver `BOT_INBOUND_AUDIO_OPTS`.
   */
  audio?: { url: string; durationSec?: number };
  /**
   * Transcripción ya obtenida, guardada en el job tras la primera llamada al
   * proveedor. Si un reintento la encuentra, no se vuelve a transcribir: cada
   * llamada se paga y el audio puede haber caducado ya.
   */
  transcript?: string;
  transcriptModel?: string;
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
  /**
   * Los de texto también llevan prioridad, aunque sea la baja.
   *
   * No es cosmético: BullMQ mete los jobs CON `priority` en un ZSET aparte
   * (`prioritized`) y los que no la llevan en la lista `wait`, y
   * `moveToActive` vacía **la lista entera** antes de mirar el ZSET. O sea que
   * un job "prioritario" entre jobs sin prioridad va el ÚLTIMO. Con los dos en
   * el ZSET, el orden lo decide el score y el audio sí adelanta.
   */
  priority: 10,
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

/**
 * Opciones del job de audio. Se separan de las normales porque la ventana es
 * corta: WAHA borra el fichero a los 900 s, así que un job que espere su turno
 * detrás de una cola larga, o que reintente con backoff exponencial de 2 s → 4 s
 * → 8 s, puede llegar tarde y encontrarse un 404.
 *
 * `priority: 1` (la más alta en BullMQ) lo pone por delante de los mensajes de
 * texto, que no caducan. El backoff es fijo y corto por el mismo motivo, y los
 * intentos bajan a 2: si el audio ya no está, reintentar no lo trae de vuelta —
 * el `MediaExpiredError` corta antes de gastar el segundo.
 */
export const BOT_INBOUND_AUDIO_OPTS = {
  ...BOT_INBOUND_JOB_OPTIONS,
  /** Menor score = antes. Adelanta al texto (10) dentro del mismo ZSET. */
  priority: 1,
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 3_000 },
  /**
   * Los fallidos de audio se retienen **lo que vive el fichero**, no 24 h: el
   * job lleva un enlace de descarga a la grabación real del paciente, y
   * guardar ese identificador en Redis después de que el audio ya no exista no
   * aporta nada y sí alarga la exposición.
   */
  removeOnFail: { age: 900, count: 200 },
};

/**
 * Transcripción de notas de voz: apagada por defecto.
 *
 * No es un flag de rollout, es un gate de cumplimiento. El texto del consent
 * (ADR 0004 §7) dice que "tus mensajes" se procesan con IA; mandar
 * **grabaciones** es un salto que ese texto no explica, y el ADR exige consent
 * explícito o handoff. Se enciende cuando el texto nuevo esté publicado y
 * versionado (PR 3 de M10), no antes.
 *
 * Con el flag apagado, el comportamiento es exactamente el de hoy: el paciente
 * recibe el aviso de "solo puedo leer texto" y, al segundo audio seguido, se le
 * deriva a una persona.
 */
export function isSttEnabled(): boolean {
  return process.env.STT_ENABLED === 'true';
}
