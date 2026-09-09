import { getSiteUrl } from '@/lib/site-url';
import { JsonLd } from './JsonLd';

/**
 * `Organization` básico para la Knowledge Graph de Google. Sin dirección ni
 * redes sociales: durante el piloto no hay datos que afirmar más allá de
 * nombre, dominio, logo y email de contacto.
 */
export function OrganizationJsonLd() {
  const base = getSiteUrl();
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Showly',
        url: base,
        logo: `${base}/showly-wordmark.svg`,
        email: 'hola@showly.tech',
      }}
    />
  );
}
