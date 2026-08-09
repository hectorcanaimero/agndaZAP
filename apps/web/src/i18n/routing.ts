import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

/**
 * Rutas i18n compartidas por el middleware, los Server Components y el `Link`
 * cliente. Locales soportados: `es` (default, ES-Rioplatense/LATAM) y `pt`
 * (portugués Brasil). El prefijo se aplica siempre (`/es/...`, `/pt/...`) para
 * evitar ambigüedad en producción.
 */
export const routing = defineRouting({
  locales: ['es', 'pt'],
  defaultLocale: 'es',
  localePrefix: 'always',
});

export const { Link, redirect, usePathname, useRouter } =
  createNavigation(routing);
