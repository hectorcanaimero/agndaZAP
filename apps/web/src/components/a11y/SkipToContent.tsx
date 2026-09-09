import { getTranslations } from 'next-intl/server';

/**
 * Link "Saltar al contenido" (WCAG 2.4.1). Va al inicio del <body>, visible
 * sólo al recibir foco por teclado. Cada layout expone su contenedor
 * principal con `id="main"` y `tabIndex={-1}` para que el salto mueva el foco.
 */
export async function SkipToContent() {
  const t = await getTranslations('common');
  return (
    <a
      href="#main"
      className="sr-only z-[100] rounded-md bg-brand-navy px-4 py-3 text-sm font-semibold text-white shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
    >
      {t('skipToContent')}
    </a>
  );
}
