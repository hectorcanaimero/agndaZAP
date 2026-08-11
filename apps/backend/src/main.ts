import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import helmet from 'helmet';
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

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Fail-fast en producción: si faltan env vars críticas, morir antes de bootstrappear
  // Nest (ahorra logs confusos y evita que arranque a medias). En dev seguimos con
  // defaults sensatos para no fricción local.
  if (process.env.NODE_ENV === 'production') {
    // `CORS_ORIGINS` es obligatoria en prod: sin whitelist explícita, `enableCors`
    // bloquea todo lo cross-origin. Si el ops se olvida de setearla, mejor fallar
    // temprano acá que dejar el panel/página pública sin poder pegarle al API.
    const required = [
      'DATABASE_URL',
      'REDIS_URL',
      'WAHA_BASE_URL',
      'WAHA_API_KEY',
      'CORS_ORIGINS',
      // Sin JWT_SECRET no podemos firmar tokens — mejor fallar al bootstrap
      // que arrancar y tirar 500 en el primer login.
      'JWT_SECRET',
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(`Faltan env vars en producción: ${missing.join(', ')}`);
    }

    // Refuerzo específico sobre JWT_SECRET: no basta con "existe", tiene que
    // ser SUFICIENTEMENTE FUERTE. Un secret corto o con prefijo `dev-` es un
    // smell obvio de olvido de rotación al pasar a prod.
    // - `< 32 chars` → HS256 pierde entropía útil. Recomendado 48+ bytes base64.
    // - `startsWith('dev-')` → el default del repo; en prod es error fatal.
    const jwtSecret = process.env.JWT_SECRET ?? '';
    if (jwtSecret.length < 32) {
      throw new Error(
        'JWT_SECRET debe tener al menos 32 caracteres en producción',
      );
    }
    if (jwtSecret.startsWith('dev-')) {
      throw new Error('JWT_SECRET no puede tener prefijo "dev-" en producción');
    }
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

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

  // Health-monitor de sesiones WAHA. Repeatable job cada N minutos que corre
  // `WahaHealthMonitor.checkAll()`. El `jobId` fijo hace que BullMQ dedupe el
  // repeatable a través de restarts del backend (idempotente). Si se revierte
  // este bloque, limpiar el estado del repeatable con:
  //   docker exec agendazap-redis-1 redis-cli DEL bull:waha-health:*
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
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port);
  logger.log(`AgendaZap backend escuchando en http://localhost:${port}`);
  logger.log(`Webhook WAHA: POST http://localhost:${port}/webhooks/waha`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap falló:', err);
  process.exit(1);
});
