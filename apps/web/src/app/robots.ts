import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { getSiteUrl } from '@/lib/site-url';

/**
 * robots.txt: se indexa todo lo público salvo panel, admin, invitaciones,
 * API y las páginas de agendamiento de clínicas (`/agendar/*` contiene la
 * agenda privada de cada tenant; el link se comparte por WhatsApp, no por
 * buscadores).
 *
 * Listamos las rutas con y sin prefijo de locale: el middleware redirige
 * `/panel` → `/es/panel`, pero los crawlers evalúan el path tal cual.
 */
const PRIVATE_PATHS = ['/panel', '/admin', '/invite', '/agendar'] as const;

export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();
  const disallow = [
    '/api/',
    ...PRIVATE_PATHS.map((p) => `${p}/`),
    ...routing.locales.flatMap((l) =>
      PRIVATE_PATHS.map((p) => `/${l}${p}/`),
    ),
  ];

  return {
    rules: [{ userAgent: '*', allow: '/', disallow }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
