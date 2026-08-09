import { Logger } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { WahaHealthMonitor } from './health-monitor.service';

/**
 * Nombre de la cola BullMQ que dispara el health-check periodico.
 * Constante compartida entre el provider (whatsapp.module) y el worker (main.ts).
 */
export const WAHA_HEALTH_QUEUE = 'waha-health';

/**
 * Nombre del unico job que corre en la cola. `jobId` fijo (ver main.ts) hace
 * que el repeatable sea idempotente al restart del backend.
 */
export const WAHA_HEALTH_JOB = 'tick';

/**
 * Token de DI para la Queue de health-monitor.
 *
 * Usamos Symbol (no la clase `Queue` como en reminders) porque WhatsappModule
 * podria en el futuro tener mas de una Queue y `Queue` como token colisionaria.
 * Reminders usa la clase directamente porque alli solo hay una y esta el
 * comentario justificando el atajo.
 */
export const WAHA_HEALTH_QUEUE_TOKEN = Symbol('WAHA_HEALTH_QUEUE');

/**
 * Crea el Worker BullMQ que ejecuta el tick del `WahaHealthMonitor`.
 *
 * Mismo patron que `createRemindersWorker`: recibe la conexion Redis y las
 * dependencias resueltas desde Nest, y devuelve el Worker para que main.ts
 * lo cierre en el shutdown handler.
 *
 * Retry: NO se configura `attempts` — un tick fallido no se re-intenta porque
 * el proximo tick llega en `WAHA_HEALTH_INTERVAL_MIN` minutos y arregla el
 * gap. Retry inmediato solo agregaria ruido si WAHA esta caido.
 *
 * Log: al fallar loguea `error` con el jobId y rethrows para que BullMQ marque
 * el job como failed (feed util para observabilidad futura).
 */
export function createHealthMonitorWorker(
  connection: { host: string; port: number },
  monitor: WahaHealthMonitor,
): Worker {
  const logger = new Logger('HealthMonitorWorker');

  return new Worker(
    WAHA_HEALTH_QUEUE,
    async (job: Job) => {
      if (job.name !== WAHA_HEALTH_JOB) return;
      try {
        return await monitor.checkAll();
      } catch (err) {
        logger.error(
          `Job ${job.id} fallo: ${(err as Error).message ?? 'unknown'}`,
        );
        throw err;
      }
    },
    { connection },
  );
}
