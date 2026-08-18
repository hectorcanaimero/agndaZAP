import createNextIntlPlugin from 'next-intl/plugin';
import { withSentryConfig } from '@sentry/nextjs';

// Puntamos al request config compartido en `src/i18n/request.ts`. next-intl v3
// consume esta config para hidratar mensajes en Server Components.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Sin `experimental.typedRoutes` porque combinado con `[locale]/[clinicSlug]`
  // dinámicos y next-intl aún da warnings en Next 15; lo dejamos para más tarde.
};

// Sentry wrap del config final. `withSentryConfig` no init Sentry — solo
// inyecta las opciones de build (sourcemap upload, release tracking).
// El init runtime vive en `instrumentation.ts` (server/edge) y
// `instrumentation-client.ts` (browser).
export default withSentryConfig(withNextIntl(nextConfig), {
  // Silenciar logs del plugin en dev — en CI se activa para debug de builds.
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Sube sourcemaps a Sentry para stack traces legibles.
  // Solo si SENTRY_AUTH_TOKEN está seteado (build time, en CI/prod).
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  reactComponentAnnotation: { enabled: true },
  // Tunneling: proxy los eventos de Sentry por nuestra api route para evitar
  // ad-blockers. Opt-in via env — en prod probablemente sí, en dev no.
  tunnelRoute: process.env.SENTRY_TUNNEL_ROUTE || undefined,
  disableLogger: true,
  automaticVercelMonitors: false,
});
