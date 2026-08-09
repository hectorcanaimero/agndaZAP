import { getTranslations } from 'next-intl/server';

/**
 * Renderizado cuando el slug no existe.
 *
 * Truco de zone: como el layout de [locale] llama a `setRequestLocale` antes,
 * podemos usar `getTranslations` con el namespace `page`. Si el 404 se dispara
 * desde la raíz sin locale, next-intl cae al default (`es`).
 */
export default async function NotFound() {
  const t = await getTranslations('page');
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md rounded-lg bg-white p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">
          {t('clinicNotFound')}
        </h1>
        <p className="mt-2 text-gray-600">{t('clinicNotFoundDescription')}</p>
      </div>
    </main>
  );
}
