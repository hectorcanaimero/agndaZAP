import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

/**
 * Config que next-intl consume en cada request server-side para hidratar
 * `useTranslations`. Aquí resolvemos el locale del segmento `[locale]` y
 * cargamos el JSON de mensajes correspondiente.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = routing.locales.includes(requested as 'es' | 'pt')
    ? (requested as 'es' | 'pt')
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
