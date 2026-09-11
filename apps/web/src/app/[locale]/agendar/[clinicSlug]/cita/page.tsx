import { CalendarX2, RefreshCw } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { fetchManagedAppointment } from '@/lib/api';
import { ManageAppointmentClient } from './ManageAppointmentClient';

/**
 * Gestión de cita por link: `/[locale]/agendar/[clinicSlug]/cita?t=<token>`.
 *
 * El link se lo mandamos al paciente por WhatsApp (confirmación, recordatorio,
 * respuesta del bot a REPROGRAMAR/CANCELAR) y también aparece en `/gracias`.
 *
 * Server Component: hidrata contra `GET …/appointments/manage/:token` sin
 * cachear y pasa los datos al client, que maneja cancelar y reagendar.
 *
 * **Una sola pantalla de error para todos los fallos de token.** El backend
 * responde el mismo 404 si el token expiró, si es de otra clínica o si la cita
 * ya no existe — deliberadamente, para no confirmarle nada a quien prueba
 * tokens. El front no puede distinguirlos y tampoco debe intentarlo.
 *
 * Un fallo **transitorio** (backend caído, 429) sí se distingue del 404: si
 * los mezcláramos, un paciente con una cita perfectamente viva vería "este
 * link no vale" con un botón de agendar, y acabaría con una cita duplicada.
 */

/**
 * La URL lleva el token en la query. Que no se indexe: un buscador no debería
 * archivar un link que permite cancelar una cita.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};
export default async function GestionCitaPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; clinicSlug: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { locale, clinicSlug } = await params;
  setRequestLocale(locale);

  const search = await searchParams;
  const tokenParam = search.t;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;

  const t = await getTranslations('manage');

  // Sin token no hay nada que pedirle al backend: misma pantalla que un token
  // inválido, sin gastar una request.
  let data = null;
  let transientError = false;
  if (token) {
    try {
      data = await fetchManagedAppointment(clinicSlug, token);
    } catch (e) {
      // Backend caído o rate-limit: NO es un link inválido. Se lo decimos como
      // lo que es, con opción de reintentar, en vez de empujarle a agendar de
      // nuevo una cita que probablemente sigue viva.
      console.error(
        `[cita] no se pudo hidratar la gestión clinic=${clinicSlug}: ${
          (e as Error).message
        }`,
      );
      transientError = true;
    }
  }

  if (transientError) {
    return (
      <main
        id="main"
        tabIndex={-1}
        className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8"
      >
        <Card className="w-full max-w-md shadow-sm">
          <CardContent className="p-8 text-center">
            <div
              className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100"
              aria-hidden="true"
            >
              <RefreshCw className="h-6 w-6 text-gray-400" />
            </div>
            <h1 className="mt-4 text-xl font-bold tracking-tight text-gray-900">
              {t('unavailable.title')}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {t('unavailable.description')}
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!data || !token) {
    return (
      <main
        id="main"
        tabIndex={-1}
        className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8"
      >
        <Card className="w-full max-w-md shadow-sm">
          <CardContent className="p-8 text-center">
            <div
              className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100"
              aria-hidden="true"
            >
              <CalendarX2 className="h-6 w-6 text-gray-400" />
            </div>
            <h1 className="mt-4 text-xl font-bold tracking-tight text-gray-900">
              {t('invalid.title')}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {t('invalid.description')}
            </p>
            <Link
              href={`/${locale}/agendar/${clinicSlug}`}
              className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              {t('invalid.cta')}
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-gray-50 px-4 py-8 md:py-12">
      <div className="mx-auto max-w-2xl">
        <ManageAppointmentClient
          clinicSlug={clinicSlug}
          locale={locale}
          token={token}
          initial={data}
        />
      </div>
    </main>
  );
}
