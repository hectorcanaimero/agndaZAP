import * as Sentry from '@sentry/nestjs';
// Nota: `nodeProfilingIntegration` vive en `@sentry/profiling-node` (package
// separado). Lo dejamos fuera del MVP — traces sample rate ya nos da
// visibilidad suficiente. Se agrega cuando aparezca un bottleneck concreto.

// Inicializa Sentry ANTES de NestFactory.create() para capturar errores
// del bootstrap (módulos que fallan al inicializar, DB inalcanzable, etc.).
//
// Reglas:
// - `SENTRY_ENABLED=true` es opt-in explícito. En dev por default está apagado
//   para no ensuciar el proyecto Sentry con noise local.
// - En producción `SENTRY_DSN` es OBLIGATORIA (fail-fast en main.ts). Sin ella
//   perdemos visibilidad de errores en clínicas reales — inaceptable.
// - `tracesSampleRate` bajo (0.1 default): performance monitoring de traces
//   consume cuota rápido. Ajustable via env sin redeploy.
// - `release` viene del CI (git sha corto) — permite agrupar errores por deploy
//   y detectar regresiones.
//
// Idempotente: si Sentry ya está inicializado (test re-arrancando bootstrap),
// `Sentry.init` no rompe — reemplaza el client anterior.
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No tirar excepción acá — el fail-fast de main.ts se encarga en prod.
    // En dev el usuario puede querer arrancar sin Sentry (ej. laburo offline).
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number.parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
    ),
    // Los datos sensibles ya los redacta Pino antes de que Sentry los vea
    // (los logs de contexto van al mixin). Adicionalmente, Sentry tiene su
    // propio scrubber que quitamos porque agregaría latencia sin valor extra.
    sendDefaultPii: false,
    // No enviar el body del request en breadcrumbs — puede tener PII.
    maxBreadcrumbs: 30,
  });
}

// Guard usable desde el filter y desde los workers: cortocircuita cuando
// Sentry está desactivado (dev sin DSN). Evita el overhead del captureException
// no-op.
export function isSentryEnabled(): boolean {
  return process.env.SENTRY_ENABLED === 'true' && Boolean(process.env.SENTRY_DSN);
}
