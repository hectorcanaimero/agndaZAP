/**
 * URL pública del sitio web (sin barra final).
 *
 * Fuente: `NEXT_PUBLIC_WEB_URL` (build-time, ver Dockerfile). Si no está,
 * caemos al dominio de producción para que sitemap/robots/JSON-LD nunca
 * emitan URLs relativas o `undefined`. El layout usa esta misma URL como
 * `metadataBase` para que las imágenes OG salgan absolutas.
 */
export const DEFAULT_SITE_URL = 'https://showly.tech';

export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_WEB_URL?.trim();
  if (!raw) return DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, '');
}
