import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import {
  buildLeadsQueryString,
  type LeadsListResponse,
} from '@/lib/api';
import { LeadsClient } from './LeadsClient';

/**
 * `/[locale]/panel/leads` — vista admin del funnel de prospects.
 *
 * Fase 1: solo lectura. El PATCH de status (mover NEW → CONTACTED, etc)
 * queda para un commit siguiente — ver comentario en `LeadsClient`.
 *
 * SSR: hacemos el fetch inicial en el server con el token del cookie para
 * pintar la primera página sin round-trip extra. TanStack Query hidrata
 * con este `initial` y luego revalida en el cliente conforme cambian los
 * filtros (paginación, status).
 *
 * NOTA sobre acceso: el endpoint del backend está restringido a `SUPERADMIN`
 * (ver `AdminLeadsController`). Si el user no tiene ese rol, el fetch va a
 * responder 403 y mostramos el mismo error banner que para otros fallos —
 * no necesitamos check duplicado acá porque el server es la fuente de
 * verdad para autorización.
 */
export default async function LeadsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.leads');

  const token = await getTokenFromCookies();
  const initialParams = { page: 1, pageSize: 20 };
  const res = await fetcher<LeadsListResponse>(
    `/api/leads?${buildLeadsQueryString(initialParams)}`,
    { token },
  );

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
          <LeadsClient locale={locale} initial={res.data} />
        </div>
      )}
    </div>
  );
}
