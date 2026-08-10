import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { FaqClient } from './FaqClient';

/**
 * Shape del `FaqChunk` como viene del backend. `hasEmbedding: boolean` es
 * derivado in-DB (embedding IS NOT NULL) — el vector NUNCA viaja al cliente.
 *
 * Ver `docs/ux/2026-08-09-faq-embedding-banner.md` — sin este flag, el
 * operador NO sabe cuándo el bot puede o no responder una FAQ dada, y la
 * clínica pierde casos silenciosamente.
 *
 * `title` es opcional (nullable) — la clínica puede dejarlo vacío y el
 * fallback en UI es la primera línea del content. Ver `hints.title` en i18n.
 */
export interface FaqChunk {
  id: string;
  title: string | null;
  content: string;
  createdAt: string;
  updatedAt?: string;
  hasEmbedding: boolean;
}

export default async function FaqPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('panel.faq');

  const token = await getTokenFromCookies();
  const res = await fetcher<FaqChunk[]>('/api/faq', { token });

  const rows = res.ok ? res.data : [];
  const pendingCount = rows.filter((r) => !r.hasEmbedding).length;

  // Full-height layout (mismo patrón que agenda/servicios/profesionales).
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('titleKb')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitleKb')}</p>
      </div>

      {!res.ok ? (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: res.status })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <FaqClient
          locale={locale}
          rows={rows}
          pendingCount={pendingCount}
        />
      </div>
    </div>
  );
}
