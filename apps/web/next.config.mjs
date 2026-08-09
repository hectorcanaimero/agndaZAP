import createNextIntlPlugin from 'next-intl/plugin';

// Puntamos al request config compartido en `src/i18n/request.ts`. next-intl v3
// consume esta config para hidratar mensajes en Server Components.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Sin `experimental.typedRoutes` porque combinado con `[locale]/[clinicSlug]`
  // dinámicos y next-intl aún da warnings en Next 15; lo dejamos para más tarde.
};

export default withNextIntl(nextConfig);
