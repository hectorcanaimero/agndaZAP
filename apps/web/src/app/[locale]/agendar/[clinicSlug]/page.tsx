import { CalendarClock, MapPin, Sparkles } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { fetchClinic, fetchSchedulingSession } from '@/lib/api';
import { ScheduleForm, type SchedulePrefill } from './ScheduleForm';
import { ScheduleSelectionProvider, SelectionSummary } from './ScheduleSelection';

/**
 * Página pública SSR de agendamiento.
 *
 * Server Component: carga los datos de la clínica en el server (sin cachear)
 * y los pasa al `ScheduleForm` (client) que maneja la interacción.
 *
 * Layout: 2 columnas en desktop (info de la clínica a la izquierda como
 * "sidebar sticky", form a la derecha). En mobile stack single-column con la
 * info arriba.
 *
 * - `notFound()` si el slug no existe → renderiza `not-found.tsx` de Next.
 * - No renderiza `wahaSession`/`autoConfirm`: sólo los campos que la clínica
 *   quiere exponer al paciente.
 */
export default async function AgendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; clinicSlug: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { locale, clinicSlug } = await params;
  setRequestLocale(locale);

  const clinic = await fetchClinic(clinicSlug);
  if (!clinic) {
    notFound();
  }

  // Prefill desde el link WA: `?t=<token>`. Si el token existe, hidratamos
  // en el server (evita flash de form vacío) y pasamos como `prefill` al
  // client. Si el token es para otra clínica, redirigimos al slug correcto —
  // el paciente pinchó desde WA, no queremos pedirle "elegí clínica" acá.
  // Si expiró/inválido, seguimos sin prefill: el usuario ve el form normal
  // y (opcional en el futuro) mostramos un banner "tu link expiró".
  const search = await searchParams;
  const tokenParam = search.t;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  let prefill: SchedulePrefill | undefined;
  if (token) {
    try {
      const session = await fetchSchedulingSession(token);
      if (session) {
        if (session.clinicSlug !== clinicSlug) {
          redirect(`/${locale}/agendar/${session.clinicSlug}?t=${token}`);
        }
        prefill = {
          token,
          name: session.name ?? '',
          phone: session.phone ?? '',
          phoneEditable: session.phoneEditable,
        };
      }
    } catch {
      // Fail-open: si el backend está caído o la sesión falla, mostramos el
      // form vacío en vez de tirar 500. El paciente puede completar manual.
    }
  }

  const t = await getTranslations('page');

  // Iniciales para el "logo" fallback (primera letra o dos iniciales).
  const initials = clinic.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-gray-50 px-4 py-8 md:py-12">
      <div className="mx-auto max-w-5xl">
        {/* Provider client mínimo: el form publica su elección y la sidebar
            la muestra. Ver ScheduleSelection.tsx. */}
        <ScheduleSelectionProvider>
        <div className="grid gap-8 md:grid-cols-[320px_1fr]">
          {/* Sidebar — info clínica. Sticky en desktop para que quede visible
              mientras el paciente scrollea el form. */}
          <aside className="space-y-4 md:sticky md:top-8 md:self-start">
            <Card className="border-brand-100 shadow-sm">
              <CardContent className="p-6">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-lg font-semibold text-white shadow-sm"
                    aria-hidden="true"
                  >
                    {initials || 'AZ'}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold text-gray-900">
                      {clinic.name}
                    </p>
                    <p className="text-xs text-gray-500">{t('poweredBy')}</p>
                  </div>
                </div>

                {clinic.address ? (
                  <div className="mt-5 flex items-start gap-2 border-t border-gray-100 pt-4 text-sm text-gray-600">
                    <MapPin
                      className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
                      aria-hidden="true"
                    />
                    <p className="leading-snug">{clinic.address}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Resumen persistente de la elección actual (vacío hasta que el
                paciente elige algo). */}
            <SelectionSummary />

            {/* Info card — qué esperar (WhatsApp + fácil) */}
            <div className="rounded-lg border border-gray-200 bg-white p-4 text-xs text-gray-600 shadow-sm">
              <div className="flex items-center gap-2 text-brand-700">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                <p className="font-semibold">{t('features.title')}</p>
              </div>
              <ul className="mt-2 space-y-1.5">
                <li className="flex items-start gap-1.5">
                  <CalendarClock
                    className="mt-0.5 h-3 w-3 shrink-0 text-gray-400"
                    aria-hidden="true"
                  />
                  <span>{t('features.quick')}</span>
                </li>
                <li className="flex items-start gap-1.5">
                  <CalendarClock
                    className="mt-0.5 h-3 w-3 shrink-0 text-gray-400"
                    aria-hidden="true"
                  />
                  <span>{t('features.whatsapp')}</span>
                </li>
              </ul>
            </div>
          </aside>

          {/* Form principal */}
          <section>
            <header className="mb-6">
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">
                {t('title')}
              </h1>
              <p className="mt-1 text-sm text-gray-600">{t('subtitle')}</p>
            </header>

            <Card className="shadow-sm">
              <CardContent className="p-6 md:p-8">
                <ScheduleForm
                  clinicSlug={clinic.slug}
                  timezone={clinic.timezone}
                  services={clinic.services}
                  professionals={clinic.professionals}
                  locale={locale}
                  prefill={prefill}
                />
              </CardContent>
            </Card>
          </section>
        </div>
        </ScheduleSelectionProvider>
      </div>
    </main>
  );
}
