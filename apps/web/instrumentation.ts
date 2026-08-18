// Next 15 instrumentation hook. Se ejecuta ANTES de que el servidor arranque
// requests. Detecta el runtime y carga el config correspondiente.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Re-export requerido por Next.js 15 (instrumentation hook `onRequestError`).
// @sentry/nextjs v10 lo exporta como `captureRequestError`; lo aliaseamos.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
