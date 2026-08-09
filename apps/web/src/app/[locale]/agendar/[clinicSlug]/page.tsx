import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchClinic } from '@/lib/api';
import { ScheduleForm } from './ScheduleForm';

/**
 * Página pública SSR de agendamiento.
 *
 * Server Component: carga los datos de la clínica en el server (sin cachear)
 * y los pasa al `ScheduleForm` (client) que maneja la interacción.
 *
 * - `notFound()` si el slug no existe → renderiza `not-found.tsx` de Next.
 * - No renderiza `wahaSession`/`autoConfirm`: sólo los campos que la clínica
 *   quiere exponer al paciente.
 */
export default async function AgendarPage({
  params,
}: {
  params: Promise<{ locale: string; clinicSlug: string }>;
}) {
  const { locale, clinicSlug } = await params;
  setRequestLocale(locale);

  const clinic = await fetchClinic(clinicSlug);
  if (!clinic) {
    notFound();
  }

  const t = await getTranslations('page');

  return (
    <main className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
          <p className="mt-2 text-gray-600">{t('subtitle')}</p>
          <div className="mt-4 rounded-lg bg-white p-4 shadow-sm">
            <p className="text-lg font-semibold text-gray-900">{clinic.name}</p>
            {clinic.address ? (
              <p className="text-sm text-gray-500">{clinic.address}</p>
            ) : null}
          </div>
        </header>

        <section className="rounded-lg bg-white p-6 shadow-sm">
          <ScheduleForm
            clinicSlug={clinic.slug}
            timezone={clinic.timezone}
            services={clinic.services}
            professionals={clinic.professionals}
            locale={locale}
          />
        </section>
      </div>
    </main>
  );
}
