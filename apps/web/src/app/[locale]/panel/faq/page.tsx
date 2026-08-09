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
  // Contamos FAQs sin indexar (`hasEmbedding: false`) para el banner de aviso.
  // Estas FAQs están en DB pero el `KnowledgeService.retrieve` las filtra
  // porque el WHERE incluye `embedding IS NOT NULL` — el bot no puede
  // responderlas y hace handoff silencioso.
  const pendingCount = rows.filter((r) => !r.hasEmbedding).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('titleKb')}</h1>
        <p className="text-sm text-gray-500">{t('subtitleKb')}</p>
      </div>
      {!res.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: res.status })}
        </div>
      ) : null}
      <FaqClient locale={locale} rows={rows} pendingCount={pendingCount} />
    </div>
  );
}
