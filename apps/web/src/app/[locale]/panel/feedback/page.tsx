import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { FeedbackClient, type FeedbackListItem, type FeedbackSummary } from './FeedbackClient';

/**
 * Feedback SSR — hidrata la vista con `GET /api/feedback/summary` + los
 * primeros N registros de `GET /api/feedback`. Ambas requests van en paralelo.
 *
 * A diferencia de Pacientes/Servicios, esta ruta NO usa MasterDetailShell:
 * es una vista de reporte (read-only), no de CRUD. El layout es tipo dashboard
 * — cards de resumen + tabla por profesional + lista de últimas respuestas.
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

  if (!summaryRes.ok) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {t('loadError', { status: summaryRes.status })}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <FeedbackClient
        locale={locale}
        summaryInitial={summaryRes.data}
        listInitial={listRes.ok ? listRes.data : []}
      />
    </div>
  );
}
