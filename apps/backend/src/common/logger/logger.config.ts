import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { PII_REDACT_OPTIONS } from './pii-redactor';
import { requestContext } from './request-context';

// Config de nestjs-pino. La factory se llama en tiempo de bootstrap para
// leer envs frescas (Docker inyecta después del build).
//
// Reglas:
// - Nivel: `LOG_LEVEL` override, default `debug` en dev, `info` en prod, `silent` en test.
// - Pretty print: solo si `LOG_PRETTY=true` (dev local con `pnpm start:dev`).
//   En prod queremos JSON puro por stdout para que Axiom / docker driver lo parseen.
// - Axiom: transport activo solo si `AXIOM_ENABLED=true`. Nivel forzado a `info` en el
//   transport para no comernos el free tier con debug.
// - Base fields: `service` + `env` en TODO log entry — permite filtrar en Axiom.
// - Redact: PII_REDACT_OPTIONS (ver pii-redactor.ts).
// - RequestId: si el header `x-request-id` viene del cliente lo usamos; sino generamos
//   uno con randomUUID. El interceptor de RequestContext leerá este mismo header para
//   propagarlo al AsyncLocalStorage.
export function pinoConfig(): Params {
  const env = process.env.NODE_ENV ?? 'development';
  const isProd = env === 'production';
  const isTest = env === 'test';

  const level =
    process.env.LOG_LEVEL ?? (isTest ? 'silent' : isProd ? 'info' : 'debug');

  const targets: Array<{
    target: string;
    level: string;
    options: Record<string, unknown>;
  }> = [];

  // Pretty print para dev local (opt-in). Si no hay ningún target explícito
  // Pino escribe JSON a stdout por default — perfecto para prod + docker logs.
  if (process.env.LOG_PRETTY === 'true') {
    targets.push({
      target: 'pino-pretty',
      level,
      options: {
        colorize: true,
        singleLine: false,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    });
  }

  // Axiom ingest. Requiere AXIOM_TOKEN + AXIOM_DATASET_LOGS + AXIOM_ORG_ID.
  if (process.env.AXIOM_ENABLED === 'true') {
    targets.push({
      target: '@axiomhq/pino',
      level: 'info',
      options: {
        dataset: process.env.AXIOM_DATASET_LOGS ?? 'showly-prod',
        token: process.env.AXIOM_TOKEN ?? '',
        orgId: process.env.AXIOM_ORG_ID ?? '',
      },
    });
  }

  return {
    pinoHttp: {
      level,
      base: {
        service: 'showly-backend',
        env,
      },
      redact: PII_REDACT_OPTIONS,
      // Nota: Pino 10 NO permite `formatters.level` cuando hay
      // `transport.targets` (los targets corren en un worker separado y no
      // heredan formatters custom del main thread). Aceptamos level numérico
      // (30=info, 40=warn, 50=error) — Axiom UI y pino-pretty lo mapean
      // automáticamente a string legible. Sin trade-off funcional real.
      // Mixin — se ejecuta en CADA log entry, inyecta el contexto del
      // AsyncLocalStorage si hay un request activo. Permite que un
      // `logger.info(...)` desde cualquier service herede automáticamente
      // requestId/clinicId/userId sin que el service tenga que pasarlos.
      mixin: () => {
        const store = requestContext.getStore();
        if (!store) return {};
        // Solo incluir campos definidos — Axiom indexa mejor sin nulls explícitos.
        const out: Record<string, string> = { requestId: store.requestId };
        if (store.clinicId) out.clinicId = store.clinicId;
        if (store.userId) out.userId = store.userId;
        if (store.impersonatedBy) out.impersonatedBy = store.impersonatedBy;
        return out;
      },
      // Epoch ms (default de Pino ya lo hace, pero explícito por claridad).
      timestamp: () => `,"time":${Date.now()}`,

      // requestId: honra x-request-id del cliente si viene, sino genera uno.
      // Mismo header que lee RequestContextInterceptor — un único source of truth.
      genReqId: (req: IncomingMessage) => {
        const header = req.headers['x-request-id'];
        if (typeof header === 'string' && header.length > 0) return header;
        if (Array.isArray(header) && header[0]) return header[0];
        return randomUUID();
      },

      // Serializers: recorta req/res para no volar el log con headers completos.
      // Los campos sensibles ya los cubre `redact`.
      serializers: {
        req: (req: IncomingMessage & { id?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          headers: {
            host: req.headers.host,
            'user-agent': req.headers['user-agent'],
            referer: req.headers.referer,
          },
        }),
        res: (res: ServerResponse) => ({
          statusCode: res.statusCode,
        }),
      },

      // Log level de request completion basado en status.
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },

      customSuccessMessage: (req, res) => {
        return `${req.method ?? '?'} ${req.url ?? '/'} ${res.statusCode}`;
      },

      customErrorMessage: (req, res, err) => {
        return `${req.method ?? '?'} ${req.url ?? '/'} ${res.statusCode} ${err.message}`;
      },

      // No loguear el body del request por default — puede tener PII.
      // Si se necesita, se hace explícito en el service con this.logger.debug().
      autoLogging: {
        ignore: (req) => {
          // Silencia health checks para no saturar Axiom.
          return req.url === '/api/health' || req.url === '/api/health/live';
        },
      },

      transport: targets.length > 0 ? { targets } : undefined,
    },
  };
}
