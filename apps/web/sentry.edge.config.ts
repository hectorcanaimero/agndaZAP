// Sentry init para Edge runtime (middleware.ts, endpoints con
// `export const runtime = 'edge'`). Se ejecuta desde instrumentation.ts
// cuando NEXT_RUNTIME==='edge'.
//
// Edge runtime es limitado: no todos los integrations de Sentry funcionan.
// Init mínimo por ahora — traces y errores básicos.
import * as Sentry from '@sentry/nextjs';

const enabled = process.env.SENTRY_ENABLED === 'true';

if (enabled && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NODE_ENV ??
      'development',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number.parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
    ),
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
  });
}
