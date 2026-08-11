import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { FeedbackClient, type FeedbackListItem, type FeedbackSummary } from './FeedbackClient';

/**
 * Feedback SSR — hidrata la vista con `GET /api/feedback/summary` + los
 * primeros N registros de `GET /api/feedback`. Ambas requests van en paralelo.
 *
 * Layout full-height master-detail (mismo patrón que servicios/agenda/conversaciones):
 * lista de respuestas en el sidebar; panel derecho muestra el dashboard agregado
 * (empty) o el detalle del feedback seleccionado.
 *
 * Nota PII: `patientName` y `comment` viajan del backend a este componente y
 * al cliente. NO deben loguearse a analytics ni a Sentry. El componente cliente
 * los muestra tal cual sin masking (el operador de la clínica tiene consent).
 */
export default async function FeedbackPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.feedback');

  const token = await getTokenFromCookies();
  const [summaryRes, listRes] = await Promise.all([
    fetcher<FeedbackSummary>('/api/feedback/summary', { token }),
    fetcher<FeedbackListItem[]>('/api/feedback?limit=50', { token }),
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!summaryRes.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: summaryRes.status })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <FeedbackClient
          locale={locale}
          summaryInitial={
            summaryRes.ok
              ? summaryRes.data
              : {
                  count: 0,
                  average: 0,
                  distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
                  byProfessional: [],
                }
          }
          listInitial={listRes.ok ? listRes.data : []}
        />
      </div>
    </div>
  );
}
