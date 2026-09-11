import 'reflect-metadata';
// initSentry() DEBE llamarse ANTES de importar AppModule para capturar
// errores de bootstrap (módulos que fallan al inicializar). El import
// order no lo garantiza — la llamada explícita en bootstrap() sí.
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Queue } from 'bullmq';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { initSentry, isSentryEnabled } from './common/sentry/sentry.config';
import { validateProdEnv } from './common/env.util';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { WahaService } from './whatsapp/waha.service';
import { WahaHealthMonitor } from './whatsapp/health-monitor.service';
import {
  WAHA_HEALTH_JOB,
  WAHA_HEALTH_QUEUE_TOKEN,
  createHealthMonitorWorker,
} from './whatsapp/health-monitor.processor';
import { createRemindersWorker } from './reminders/reminders.processor';
import { parseRedis } from './reminders/reminders.module';
import { createFollowUpsWorker } from './follow-ups/follow-ups.processor';
import {
  createBotInboundWorker,
  safeErrorLabel,
} from './bot/bot-inbound.processor';
import { BOT_INBOUND_QUEUE_TOKEN } from './bot/bot-inbound.queue';
import { BotService } from './bot/bot.service';

async function bootstrap(): Promise<void> {
  // Sentry ANTES que cualquier NestFactory / Module init. Sin esto, si un
  // provider falla en su constructor, perdemos el error (no llega al filter).
  if (isSentryEnabled()) {
    initSentry();
  }

  // Fail-fast en producción: si faltan env vars críticas, morir antes de bootstrappear
  // Nest (ahorra logs confusos y evita que arranque a medias). En dev seguimos con
  // defaults sensatos para no fricción local.
  if (process.env.NODE_ENV === 'production') {
    // Lista + reglas en `common/env.util.ts` (pura, con tests). Incluye los
    // secretos del webhook WAHA: sin WEBHOOK_HMAC_SECRET ni WEBHOOK_TOKEN el
    // backend arrancaría pero rechazaría todos los webhooks con 403.
    const errors = validateProdEnv(process.env);
    if (errors.length) {
      throw new Error(errors.join('\n'));
    }
  }

  // `bufferLogs: true` retiene los logs internos de Nest hasta que
  // `app.useLogger()` los adopte — sin esto perdemos los mensajes de
  // inicialización (module init, route mapping) en Pino.
  // `rawBody: true`: Nest guarda los bytes originales en `req.rawBody` con SU
  // propio body-parser (Express 4). Antes registrábamos `express.json()` del
  // paquete `express` v5 además del parser de Nest: dos parsers de versiones
  // distintas sobre el mismo stream → "stream is not readable" (500) en TODO
  // POST con JSON, login y webhook incluidos. Visto en el primer deploy real
  // (Coolify, 2026-09-09).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  // Reemplazar el Logger default de Nest por Pino global. A partir de acá
  // TODOS los `Logger.log()` internos de Nest y los `logger.log()` de este
  // bootstrap salen como JSON estructurado con los base fields
  // (service, env) y respetando el `redact` de PII.
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Trust proxy: si el backend está detrás de un proxy confiable (Cloudflare,
  // nginx, ALB), Express necesita saberlo para resolver `req.ip` desde el
  // primer valor de `X-Forwarded-For` en vez de la IP del proxy. Sin este
  // toggle, todos los requests parecen venir de la misma IP interna y
  // rompen el rate-limit por IP.
  // Match con `extractIp(req, TRUST_PROXY==='true')` en rate-limit.guard.ts.
  if (process.env.TRUST_PROXY === 'true') {
    const httpAdapter = app.getHttpAdapter();
    const instance = httpAdapter.getInstance();
    if (typeof instance.set === 'function') {
      instance.set('trust proxy', 1);
    }
  }

  // Límite del body: el default de Nest es 100kb; los payloads del webhook
  // WAHA (mensajes con metadata) y los FAQ largos del panel lo superan.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });

  // Helmet ANTES de CORS: headers de seguridad (X-Content-Type-Options,
  // Strict-Transport-Security, referrer-policy, etc.) aplican también a la
  // respuesta preflight de CORS. Config default de helmet — no ajustamos CSP
  // porque servimos JSON, no HTML.
  app.use(helmet());

  // CORS con whitelist explícita.
  // - En prod sin `CORS_ORIGINS`: bloqueamos todo (`origin: false`). Esto no
  //   debería ocurrir porque el fail-fast de arriba ya exige la env var; queda
  //   como red de seguridad extra.
  // - En dev sin `CORS_ORIGINS`: `origin: true` (permite todo — cómodo para
  //   desarrollo local con múltiples puertos).
  // - Con `CORS_ORIGINS=https://foo,https://bar`: whitelist exacto.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin:
      corsOrigins.length > 0
        ? corsOrigins
        : process.env.NODE_ENV === 'production'
          ? false
          : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // El webhook de WAHA NO debe llevar el prefijo /api porque WHATSAPP_HOOK_URL
  // apunta a http://backend:4000/webhooks/waha (ver docker-compose.yml).
  // Los feeds iCal tampoco: los clientes de calendar (iOS/Android/Google) no
  // envían Bearer y no queremos anteponer /api a una URL que el usuario
  // copia/pega en su app. Ver `ProfessionalsIcalController` (@Public + HMAC).
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'webhooks/(.*)', method: RequestMethod.ALL },
      { path: 'ical/(.*)', method: RequestMethod.ALL },
    ],
  });

  // Cierre limpio de Prisma (delega en beforeExit → app.close()).
  const prisma = app.get(PrismaService);
  await prisma.enableShutdownHooks(app);

  // Bootstrap del worker BullMQ. Comparte Redis con la Queue vía parseRedis().
  const waha = app.get(WahaService);
  const worker = createRemindersWorker(parseRedis(), prisma, waha);
  worker.on('ready', () => logger.log('RemindersWorker listo'));
  worker.on('failed', (job, err) => {
    // BullMQ puede entregar `err` undefined en edges raros; blindamos el log.
    logger.error(`Job ${job?.id} falló: ${err?.message ?? 'unknown'}`);
  });

  // Worker de follow-ups post-atención (satisfacción). Misma conexión Redis
  // que reminders (parseRedis()). Es un worker separado porque la Queue es
  // distinta — así el failure de uno no arrastra al otro.
  const followUpsWorker = createFollowUpsWorker(parseRedis(), prisma, waha);
  followUpsWorker.on('ready', () => logger.log('FollowUpsWorker listo'));
  followUpsWorker.on('failed', (job, err) => {
    logger.error(
      `FollowUp job ${job?.id} falló: ${err?.message ?? 'unknown'}`,
    );
  });

  // Worker de mensajes entrantes de WhatsApp. El webhook encola y responde 200
  // al instante; el trabajo lento (LLM, FSM, RAG) pasa por aquí. Sin esto, WAHA
  // reintentaba el webhook por timeout y el mismo mensaje se procesaba dos
  // veces. Ver [[notas/2026-09-11-cola-bot-inbound]].
  const botInboundWorker = createBotInboundWorker(
    parseRedis(),
    app.get(BotService),
    prisma,
  );
  botInboundWorker.on('ready', () => logger.log('BotInboundWorker listo'));
  botInboundWorker.on('failed', (job, err) => {
    // Ni `job.data` ni `err.message` crudos: los dos pueden llevar el texto
    // del paciente (ver `safeErrorLabel`).
    //
    // Sólo los intentos intermedios, y a nivel `warn`: el descarte definitivo
    // lo loguea el processor con su contexto. Si no, un mensaje perdido deja
    // cuatro líneas de `error` y la alerta real se ahoga en el ruido.
    const attempt = (job?.attemptsMade ?? 0) + 1;
    const isLast = attempt >= (job?.opts?.attempts ?? 1);
    if (isLast) return;
    logger.warn(
      `BotInbound job ${job?.id} falló (intento ${attempt}, reintentando): ${safeErrorLabel(err)}`,
    );
  });

  // Health-monitor de sesiones WAHA. Repeatable job cada N minutos que corre
  // `WahaHealthMonitor.checkAll()`. El `jobId` fijo hace que BullMQ dedupe el
  // repeatable a través de restarts del backend (idempotente). Si se revierte
  // este bloque, limpiar el estado del repeatable con:
  //   docker exec showly-redis-1 redis-cli DEL bull:waha-health:*
  const healthQueue = app.get<Queue>(WAHA_HEALTH_QUEUE_TOKEN);
  const healthMonitor = app.get(WahaHealthMonitor);
  const intervalMin = Number(process.env.WAHA_HEALTH_INTERVAL_MIN ?? 5);
  await healthQueue.add(
    WAHA_HEALTH_JOB,
    {},
    {
      repeat: { every: intervalMin * 60_000 },
      jobId: 'waha-health-monitor-tick',
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
  const healthWorker = createHealthMonitorWorker(parseRedis(), healthMonitor);
  healthWorker.on('ready', () => logger.log('HealthMonitorWorker listo'));
  healthWorker.on('failed', (job, err) => {
    logger.error(
      `HealthMonitor job ${job?.id} falló: ${err?.message ?? 'unknown'}`,
    );
  });
  logger.log(`waha-health-monitor programado cada ${intervalMin}m`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Recibido ${signal}, cerrando…`);
    try {
      await worker.close();
    } catch (e) {
      logger.error(`Error cerrando worker: ${(e as Error).message}`);
    }
    try {
      await followUpsWorker.close();
    } catch (e) {
      logger.error(
        `Error cerrando follow-ups worker: ${(e as Error).message}`,
      );
    }
    try {
      await botInboundWorker.close();
    } catch (e) {
      logger.error(
        `Error cerrando bot-inbound worker: ${(e as Error).message}`,
      );
    }
    try {
      await healthWorker.close();
    } catch (e) {
      logger.error(
        `Error cerrando health worker: ${(e as Error).message}`,
      );
    }
    try {
      await healthQueue.close();
    } catch (e) {
      logger.error(`Error cerrando health queue: ${(e as Error).message}`);
    }
    try {
      await app.close();
    } catch (e) {
      logger.error(`Error cerrando app: ${(e as Error).message}`);
    }
    // La cola se cierra DESPUÉS de `app.close()`: mientras el servidor HTTP
    // siga aceptando webhooks, `add()` tiene que funcionar. Al revés queda una
    // ventana en la que el webhook responde 500 por una cola ya cerrada.
    try {
      await app.get<Queue>(BOT_INBOUND_QUEUE_TOKEN).close();
    } catch (e) {
      logger.error(
        `Error cerrando bot-inbound queue: ${(e as Error).message}`,
      );
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port);
  logger.log(`Showly backend escuchando en http://localhost:${port}`);
  logger.log(`Webhook WAHA: POST http://localhost:${port}/webhooks/waha`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap falló:', err);
  process.exit(1);
});
