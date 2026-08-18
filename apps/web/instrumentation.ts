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

// Re-export requerido por @sentry/nextjs para instrumentar errores de RSC.
export { onRequestError } from '@sentry/nextjs';
