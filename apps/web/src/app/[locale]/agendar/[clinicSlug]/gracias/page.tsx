import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  MapPin,
  MessageCircle,
  Stethoscope,
  User,
} from 'lucide-react';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { fetchClinic } from '@/lib/api';
import { AddToCalendarButton } from './AddToCalendarButton';
import { ThanksManageLink } from './ThanksManageLink';
import { ThanksName } from './ThanksName';

/**
 * Página de confirmación post-submit.
 *
 * Query params (ninguno es PII del paciente):
 * - `date`, `time`: ya formateados en la TZ de la clínica (texto).
 * - `start`, `end`: ISO 8601 con offset/Z para el .ics (validados con Luxon;
 *   nunca `Date` naive).
 * - `appt`: id opaco de la cita → UID estable del .ics.
 * - `service`, `professional`: IDs (datos públicos de la clínica); se
 *   resuelven a nombre contra el snapshot público. Si no resuelven (p. ej.
 *   servicio desactivado) simplemente no se muestran.
 * El nombre del paciente viaja por `sessionStorage` (ver B.4 del ADR
 * `docs/adr/0004-pii-y-compliance.md`) y lo renderiza `<ThanksName />`.
 *
 * El link a WhatsApp de la clínica depende de `clinic.whatsappPhone`, que
 * el snapshot público (`GET /api/public/clinics/:slug`) todavía NO expone;
 * queda condicionado hasta que el backend lo agregue.
 */
export default async function GraciasPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; clinicSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, clinicSlug } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);

  const t = await getTranslations('thanks');
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
  const date = str('date');
  const time = str('time');
  const startISO = str('start');
  const endISO = str('end');
  const appointmentId = str('appt');

  // Fail-open: si el backend no responde, la confirmación igual se muestra.
  let clinic: Awaited<ReturnType<typeof fetchClinic>> = null;
  try {
    clinic = await fetchClinic(clinicSlug);
  } catch {
    clinic = null;
  }
  const serviceName =
    clinic?.services.find((s) => s.id === str('service'))?.name ?? null;
  const professionalName =
    clinic?.professionals.find((p) => p.id === str('professional'))?.name ??
    null;
  const whatsappPhone = clinic?.whatsappPhone?.replace(/\D/g, '') || null;

  // Sólo ISO 8601 con zona explícita (Z u offset): sin ella Luxon la
  // interpretaría en la TZ del servidor y el .ics quedaría corrido.
  const ISO_WITH_ZONE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  const validISO = (v: string) =>
    ISO_WITH_ZONE.test(v) && DateTime.fromISO(v, { setZone: true }).isValid;
  const canAddToCalendar = validISO(startISO) && validISO(endISO);
  // UID estable: id de la cita si viene; si no, hash determinista de la
  // combinación (misma cita → mismo UID → el calendario no la duplica).
  const calendarUid = appointmentId
    ? `${appointmentId}@showly`
    : `${createHash('sha256')
        .update(`${startISO}|${str('service')}|${str('professional')}`)
        .digest('hex')
        .slice(0, 32)}@showly`;

  const summaryRows = [
    { key: 'summary.service', Icon: Stethoscope, value: serviceName },
    { key: 'summary.professional', Icon: User, value: professionalName },
    {
      key: 'summary.when',
      Icon: CalendarClock,
      value: date && time ? `${date} · ${time}` : null,
    },
    { key: 'summary.address', Icon: MapPin, value: clinic?.address ?? null },
  ] as const;

  return (
    <main id="main" tabIndex={-1} className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8">
      <Card className="w-full max-w-md shadow-sm">
        <CardContent className="p-8 text-center">
          {/* Icono principal — verde brand-600 sobre halo brand-50 para
              coherencia con el resto del panel. */}
          <div
            className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50"
            aria-hidden="true"
          >
            <CheckCircle2 className="h-9 w-9 text-brand-600" />
          </div>

          <ThanksName />

          {/* Detalle de la cita — fecha/hora resaltada en un chip visual */}
          <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50/50 p-4">
            <p className="text-sm text-gray-700">
              {t('subtitle', { date, time })}
            </p>
            {summaryRows.some((r) => r.value) ? (
              <dl className="mt-3 space-y-1.5 border-t border-brand-100 pt-3 text-left">
                {summaryRows.map(({ key, Icon, value }) =>
                  !value ? null : (
                  <div key={key} className="flex items-start gap-2 text-sm">
                    <Icon
                      className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
                      aria-hidden="true"
                    />
                    <dt className="sr-only">{t(key)}</dt>
                    <dd className="text-gray-800">{value}</dd>
                  </div>
                  ),
                )}
              </dl>
            ) : null}
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-md bg-gray-50 p-3 text-left text-xs text-gray-600">
            <MessageCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
              aria-hidden="true"
            />
            <p>{t('whatsappNote')}</p>
          </div>

          <div className="mt-6 space-y-3">
            {canAddToCalendar ? (
              <AddToCalendarButton
                title={t('calendarTitle', { clinic: clinic?.name ?? clinicSlug })}
                startISO={startISO}
                endISO={endISO}
                uid={calendarUid}
                location={clinic?.address}
                description={
                  [serviceName, professionalName].filter(Boolean).join(' · ') ||
                  null
                }
              />
            ) : null}

            {whatsappPhone ? (
              <a
                href={`https://wa.me/${whatsappPhone}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                <MessageCircle className="h-4 w-4 text-brand-600" aria-hidden="true" />
                {t('whatsappLink')}
              </a>
            ) : null}
          </div>

          {/* Link de gestión de la cita. Client component: el link lleva un
              token bearer y viaja por sessionStorage, no por la query string.
              Si no hay link (Redis caído al crear la cita) no renderiza nada. */}
          <ThanksManageLink />

          <Link
            href={`/${locale}/agendar/${clinicSlug}`}
            className="mt-6 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded-sm"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('backLink')}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
