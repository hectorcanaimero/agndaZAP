// Sentry init para el runtime del browser (App Router — Next 15.3+).
// Este archivo reemplaza a `sentry.client.config.ts` de versiones previas.
import * as Sentry from '@sentry/nextjs';

const enabled = process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'true';

if (enabled && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NODE_ENV ??
      'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    tracesSampleRate: Number.parseFloat(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
    ),
    // Session Replay: capturar sesiones que tuvieron un error, útil para
    // debug de bugs del panel con clínicas reales.
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.0, // no capturar sesiones "sanas" — sube quota
    integrations: [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
    sendDefaultPii: false,
  });
}

// Export para navegación instrumentada (Next 15 pattern).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
