import { setRequestLocale, getTranslations } from 'next-intl/server';
import {
  buildLeadsQueryString,
  type LeadsListResponse,
} from '@/lib/api';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { LeadsClient } from '../../panel/leads/LeadsClient';

/**
 * `/[locale]/admin/leads` — funnel de prospects capturados desde la landing.
 *
 * Los leads son CROSS-TENANT (no tienen `clinicId`) — pertenecen al SaaS, no
 * a una clínica específica. Por eso el listado vive en el área SUPERADMIN
 * y no en el panel de clínica. El backend `GET /api/leads` está restringido
 * a `@Roles('SUPERADMIN')`; el listado del panel de clínica se removió del
 * nav (un `CLINIC_ADMIN` recibía 403 al abrirlo).
 *
 * Reusamos el mismo `LeadsClient` que existía en el panel para no duplicar
 * lógica de tabla + paginación + filtros por status. Cuando aparezcan
 * acciones específicas del super (bulk contact, export, etc), pueden vivir
 * en un nuevo `AdminLeadsClient` con override del i18n.
 */
export default async function AdminLeadsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.leads');

  const token = await getTokenFromCookies();
  const res = await fetcher<LeadsListResponse>(
    `/api/leads?${buildLeadsQueryString({ page: 1, pageSize: 20 })}`,
    { token },
  );

  const initial: LeadsListResponse = res.ok
    ? res.data
    : { items: [], total: 0, page: 1, pageSize: 20 };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!res.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError')}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <LeadsClient locale={locale} initial={initial} />
        </div>
      )}
    </div>
  );
}
