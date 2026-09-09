import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { getSiteUrl } from '@/lib/site-url';

/**
 * Sitemap de las rutas públicas indexables, en cada locale, con alternates
 * hreflang cruzados (+ x-default apuntando al locale por defecto).
 *
 * Fuera a propósito: `/agendar/[clinicSlug]` (agenda de cada clínica, no
 * debe indexarse), `/login`, `/invite`, `/panel`, `/admin`. Ver robots.ts.
 */
const PUBLIC_PATHS = [
  { path: '', changeFrequency: 'weekly', priority: 1 },
  { path: '/seguridad', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/privacidad', changeFrequency: 'monthly', priority: 0.3 },
  { path: '/terminos', changeFrequency: 'monthly', priority: 0.3 },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl();
  const lastModified = new Date();

  return PUBLIC_PATHS.flatMap(({ path, changeFrequency, priority }) => {
    const languages: Record<string, string> = Object.fromEntries(
      routing.locales.map((l) => [l, `${base}/${l}${path}`]),
    );
    languages['x-default'] = `${base}/${routing.defaultLocale}${path}`;

    return routing.locales.map((locale) => ({
      url: `${base}/${locale}${path}`,
      lastModified,
      changeFrequency,
      priority,
      alternates: { languages },
    }));
  });
}
