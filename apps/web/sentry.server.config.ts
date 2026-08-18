// Sentry init para Node runtime (RSC, API routes, server actions).
// Se ejecuta desde instrumentation.ts cuando NEXT_RUNTIME==='nodejs'.
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
    // No enviar PII automática (headers de request, cookies). El wrap
    // manual de errores en middleware puede sumar user context explícito.
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    // Debug solo si explícitamente pedido — Sentry es ruidoso en debug mode.
    debug: process.env.SENTRY_DEBUG === 'true',
  });
}
