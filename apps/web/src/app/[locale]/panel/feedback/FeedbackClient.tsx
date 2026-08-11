'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageCircle, MessageSquareHeart, Star, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

/**
 * Item de la lista `GET /api/feedback`. Contiene PII (`patientName`,
 * `comment`) — NO loguearlos ni mandarlos a analytics.
 */
export interface FeedbackListItem {
  id: string;
  score: number; // 1..5
  comment: string | null;
  respondedAt: string; // ISO — el backend serializa Date a string
  appointmentId: string;
  patientName: string | null;
  professionalId: string;
  professionalName: string;
  serviceName: string;
  appointmentStartAt: string; // ISO
}

export interface FeedbackByProfessional {
  professionalId: string;
  professionalName: string;
  count: number;
  average: number;
}

/**
 * Distribución 1..5 → count. Backend serializa como strings de dígito.
 */
export type FeedbackDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

export interface FeedbackSummary {
  count: number;
  average: number;
  distribution: FeedbackDistribution;
  byProfessional: FeedbackByProfessional[];
}

interface Props {
  locale: string;
  summaryInitial: FeedbackSummary;
  listInitial: FeedbackListItem[];
}

/* ═══════════════════════════════════════════════════════════════════
 *                          FEEDBACK CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Vista de reporte de satisfacción post-atención.
 *
 * Layout:
 * - Header con 4 stat cards: total, promedio, mejor profesional, ratio 4-5★.
 * - Barra de distribución 1..5 (compacta, visual).
 * - Tabla por profesional (ordenada por promedio desc).
 * - Lista de últimas respuestas (nombre paciente, prof/servicio, fecha, score,
 *   comentario si hay).
 *
 * Data: `useQuery` con `initialData` del SSR, `staleTime: 60s`. No hay mutations
 * — es read-only.
 */
export function FeedbackClient({
  locale,
  summaryInitial,
  listInitial,
}: Props) {
  const t = useTranslations('panel.feedback');

  const { data: summary = summaryInitial } = useQuery({
    queryKey: queryKeys.feedbackSummary,
    queryFn: () => apiQuery<FeedbackSummary>('/api/feedback/summary'),
    initialData: summaryInitial,
    staleTime: 60_000,
  });

  const { data: list = listInitial } = useQuery({
    queryKey: queryKeys.feedback({ limit: 50 }),
    queryFn: () =>
      apiQuery<FeedbackListItem[]>('/api/feedback?limit=50'),
    initialData: listInitial,
    staleTime: 60_000,
  });

  // Ranking desc por promedio (empate rompe por count desc — más muestras = más confiable).
  const rankedProfessionals = useMemo(() => {
    return [...summary.byProfessional].sort((a, b) => {
      if (b.average !== a.average) return b.average - a.average;
      return b.count - a.count;
    });
  }, [summary.byProfessional]);

  // Best professional destacado en la stat card. Solo si hay al menos 1 con respuestas.
  const best = rankedProfessionals[0];

  // Ratio de respuestas 4-5★ sobre el total — sirve para el operador como
  // "% de pacientes contentos" (proxy simple de NPS).
  const positiveRatio = useMemo(() => {
    if (summary.count === 0) return 0;
    const positive =
      summary.distribution['4'] + summary.distribution['5'];
    return positive / summary.count;
  }, [summary]);

  /* ─────────────── Empty state ─────────────── */

  if (summary.count === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-card/50 p-12 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
          <MessageSquareHeart
            className="h-8 w-8 text-brand-600"
            aria-hidden="true"
          />
        </div>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {t('empty.title')}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('empty.description')}
          </p>
        </div>
      </div>
    );
  }

  /* ─────────────── Contenido normal ─────────────── */

  return (
    <div className="space-y-6">
      {/* ─── Stat cards ─── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.total.title')}
            </CardTitle>
            <MessageCircle
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums text-foreground">
              {summary.count}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('stats.total.hint')}
            </p>
          </CardContent>
        </Card>

        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.average.title')}
            </CardTitle>
            <Star
              className="h-4 w-4 fill-amber-400 text-amber-400"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums text-foreground">
              {summary.average.toFixed(1)}
              <span className="ml-1 text-base font-normal text-muted-foreground">
                / 5
              </span>
            </p>
            <StarBar value={summary.average} className="mt-2" />
          </CardContent>
        </Card>

        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.positive.title')}
            </CardTitle>
            <MessageSquareHeart
              className="h-4 w-4 text-emerald-500"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums text-foreground">
              {(positiveRatio * 100).toFixed(0)}%
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('stats.positive.hint')}
            </p>
          </CardContent>
        </Card>

        <Card className="transition-shadow hover:shadow-md">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.top.title')}
            </CardTitle>
            <Users
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
          </CardHeader>
          <CardContent>
            {best ? (
              <>
                <p className="truncate text-base font-semibold text-foreground">
                  {best.professionalName}
                </p>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {t('stats.top.hint', {
                    avg: best.average.toFixed(1),
                    count: best.count,
                  })}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('stats.top.empty')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Distribución 1..5 ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-foreground">
            {t('distribution.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DistributionChart
            distribution={summary.distribution}
            total={summary.count}
          />
        </CardContent>
      </Card>

      {/* ─── Ranking por profesional ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-foreground">
            {t('byProfessional.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rankedProfessionals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('byProfessional.empty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 font-medium">
                      {t('byProfessional.headers.name')}
                    </th>
                    <th className="pb-2 pr-2 text-right font-medium">
                      {t('byProfessional.headers.count')}
                    </th>
                    <th className="pb-2 pl-2 font-medium">
                      {t('byProfessional.headers.average')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rankedProfessionals.map((p) => (
                    <tr
                      key={p.professionalId}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2 pr-2 font-medium text-foreground">
                        {p.professionalName}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                        {p.count}
                      </td>
                      <td className="py-2 pl-2">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums text-foreground">
                            {p.average.toFixed(1)}
                          </span>
                          <StarBar value={p.average} className="w-24" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Últimas respuestas ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-foreground">
            {t('recent.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('recent.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {list.map((item) => (
                <FeedbackRow key={item.id} item={item} locale={locale} t={t} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                          FEEDBACK ROW
 * ═══════════════════════════════════════════════════════════════════ */

function FeedbackRow({
  item,
  locale,
  t,
}: {
  item: FeedbackListItem;
  locale: string;
  t: ReturnType<typeof useTranslations<'panel.feedback'>>;
}) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {item.patientName || t('recent.unnamed')}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t('recent.metaLine', {
              professional: item.professionalName,
              service: item.serviceName,
            })}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StarBar value={item.score} />
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {formatRespondedAt(item.respondedAt, locale)}
          </p>
        </div>
      </div>
      {item.comment ? (
        <blockquote className="mt-2 rounded-md border-l-2 border-brand-500/40 bg-muted/40 px-3 py-2 text-sm italic text-foreground/90">
          {item.comment}
        </blockquote>
      ) : null}
    </li>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            SUB-COMPONENTES
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Barra visual de 5 estrellas. `value` puede ser fraccional (ej. 3.7) —
 * cada estrella se llena por su índice: full si idx+1 <= floor, half si
 * el fraccional cae en su rango, vacía si no.
 */
function StarBar({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const stars = [1, 2, 3, 4, 5];
  return (
    <div
      className={cn('flex items-center gap-0.5', className)}
      role="img"
      aria-label={`${value.toFixed(1)} / 5`}
    >
      {stars.map((s) => {
        const filled = value >= s;
        // Half-fill se aplica cuando value cae dentro del intervalo (s-1, s).
        // Por simplicidad visual, redondeamos: si value > s-0.5 → full.
        const halfFull = !filled && value > s - 0.5;
        return (
          <Star
            key={s}
            className={cn(
              'h-3.5 w-3.5',
              filled
                ? 'fill-amber-400 text-amber-400'
                : halfFull
                  ? 'fill-amber-200 text-amber-400'
                  : 'fill-transparent text-muted-foreground/40',
            )}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}

/**
 * Chart horizontal de distribución 5→1 (de mayor a menor score, más natural
 * para leer "cuántos 5★ tengo primero").
 */
function DistributionChart({
  distribution,
  total,
}: {
  distribution: FeedbackDistribution;
  total: number;
}) {
  const rows: Array<'5' | '4' | '3' | '2' | '1'> = ['5', '4', '3', '2', '1'];
  return (
    <div className="space-y-2">
      {rows.map((score) => {
        const count = distribution[score];
        const pct = total > 0 ? (count / total) * 100 : 0;
        // Color por score: 5→emerald, 4→emerald (softer), 3→amber, 2→orange, 1→red.
        const color =
          score === '5'
            ? 'bg-emerald-500'
            : score === '4'
              ? 'bg-emerald-400'
              : score === '3'
                ? 'bg-amber-400'
                : score === '2'
                  ? 'bg-orange-400'
                  : 'bg-red-500';
        return (
          <div key={score} className="flex items-center gap-3">
            <div className="flex w-10 shrink-0 items-center gap-1 text-xs font-medium text-foreground">
              <span className="tabular-nums">{score}</span>
              <Star
                className="h-3 w-3 fill-amber-400 text-amber-400"
                aria-hidden="true"
              />
            </div>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  color,
                )}
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="flex w-20 shrink-0 items-center justify-end gap-1.5 text-xs tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{count}</span>
              <span className="text-muted-foreground/70">
                ({pct.toFixed(0)}%)
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── Helpers ─────────────────────────── */

/**
 * Formatea la fecha `respondedAt` (ISO) con el locale del usuario.
 * Usa Intl.DateTimeFormat siguiendo el patrón del resto del panel
 * (Agenda/Conversaciones) — NO Luxon porque el web no tiene la dep.
 * La TZ se resuelve por el navegador; para reportes cross-clínica esto es
 * aceptable (no estamos comparando slot-vs-hoy, solo mostrando "cuándo lo dijo").
 */
function formatRespondedAt(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
