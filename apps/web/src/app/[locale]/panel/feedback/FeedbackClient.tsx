'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarCheck2,
  MessageCircle,
  MessageSquareHeart,
  Search,
  Star,
  User,
  Users,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  MasterDetailRow,
  MasterDetailShell,
  useMobileSheet,
} from '@/components/panel/master-detail';
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

/**
 * Estado del panel derecho:
 *  - `empty`  → sin selección; muestra el dashboard agregado (stats + distribución + ranking).
 *  - `detail` → muestra el detalle del feedback seleccionado.
 */
type PanelMode =
  | { kind: 'empty' }
  | { kind: 'detail'; item: FeedbackListItem };

type ScoreFilter = 'all' | 1 | 2 | 3 | 4 | 5;

/* ═══════════════════════════════════════════════════════════════════
 *                          FEEDBACK CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Vista master-detail de satisfacción post-atención.
 *
 * Aunque feedback es read-only (no hay CRUD), reusamos MasterDetailShell para
 * mantener el mismo lenguaje visual del panel (servicios/agenda/conversaciones):
 *  - Sidebar (~380px): search + filtro por score + lista con marker vertical brand.
 *  - Panel derecho: dashboard agregado o detalle del feedback.
 *  - Mobile: solo sidebar full-width; al seleccionar abre Sheet con el detalle.
 */
export function FeedbackClient({
  locale,
  summaryInitial,
  listInitial,
}: Props) {
  const t = useTranslations('panel.feedback');

  const [search, setSearch] = useState('');
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all');
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const mobileSheet = useMobileSheet();

  const { data: summary = summaryInitial } = useQuery({
    queryKey: queryKeys.feedbackSummary,
    queryFn: () => apiQuery<FeedbackSummary>('/api/feedback/summary'),
    initialData: summaryInitial,
    staleTime: 60_000,
  });

  const { data: list = listInitial } = useQuery({
    queryKey: queryKeys.feedback({ limit: 50 }),
    queryFn: () => apiQuery<FeedbackListItem[]>('/api/feedback?limit=50'),
    initialData: listInitial,
    staleTime: 60_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter((item) => {
      if (scoreFilter !== 'all' && item.score !== scoreFilter) return false;
      if (!q) return true;
      return (
        (item.patientName ?? '').toLowerCase().includes(q) ||
        item.professionalName.toLowerCase().includes(q) ||
        item.serviceName.toLowerCase().includes(q) ||
        (item.comment ?? '').toLowerCase().includes(q)
      );
    });
  }, [list, search, scoreFilter]);

  // Si el ítem activo desaparece del listado tras un refetch, volvemos al empty
  // para no mostrar datos de un feedback que ya no está.
  useEffect(() => {
    if (panel.kind !== 'detail') return;
    const stillExists = list.some((i) => i.id === panel.item.id);
    if (!stillExists) setPanel({ kind: 'empty' });
  }, [list, panel]);

  const activeId = panel.kind === 'detail' ? panel.item.id : null;

  function openDetail(item: FeedbackListItem) {
    setPanel({ kind: 'detail', item });
    mobileSheet.openIfMobile();
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    mobileSheet.close();
  }

  /* ─────── Render ─────── */

  const panelContent =
    panel.kind === 'empty' ? (
      <DashboardPanel summary={summary} locale={locale} />
    ) : (
      <DetailPanel item={panel.item} locale={locale} onClose={closePanel} />
    );

  const sidebar = (
    <>
      {/* Toolbar: search + filtro score + count */}
      <div className="shrink-0 space-y-2 border-b border-border/60 p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-9 pl-8"
            aria-label={t('searchPlaceholder')}
          />
        </div>

        <ScoreFilterChips value={scoreFilter} onChange={setScoreFilter} t={t} />

        <p className="px-0.5 text-[11px] tabular-nums text-muted-foreground">
          {t('countLabel', { n: list.length })}
          {(search || scoreFilter !== 'all') &&
          filtered.length !== list.length ? (
            <>
              {' '}
              ·{' '}
              <span className="text-foreground">
                {t('countMatch', { n: filtered.length })}
              </span>
            </>
          ) : null}
        </p>
      </div>

      {/* Lista */}
      {list.length === 0 ? (
        <SidebarEmpty t={t} />
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted-foreground">
              {t('noSearchResults')}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearch('');
                setScoreFilter('all');
              }}
            >
              {t('resetFilter')}
            </Button>
          </div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1">
          {filtered.map((item) => (
            <li key={item.id}>
              <FeedbackListRow
                item={item}
                active={item.id === activeId}
                onSelect={() => openDetail(item)}
                locale={locale}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <MasterDetailShell
      sidebar={sidebar}
      panel={panelContent}
      mobile={mobileSheet}
      mobileTitle={
        panel.kind === 'detail'
          ? (panel.item.patientName ?? t('recent.unnamed'))
          : ''
      }
      hidePanelInSheet={panel.kind === 'empty'}
      mobileSheetMaxWidth="sm:max-w-lg"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                        SCORE FILTER CHIPS
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Chips segmentados 1..5 + "todas". Compactos, tabular-nums, se pintan con el
 * color del score al activarse (5→emerald, 4→emerald, 3→amber, 2→orange, 1→red)
 * — el operador identifica el "estado" del filtro sin leer el número.
 */
function ScoreFilterChips({
  value,
  onChange,
  t,
}: {
  value: ScoreFilter;
  onChange: (v: ScoreFilter) => void;
  t: ReturnType<typeof useTranslations<'panel.feedback'>>;
}) {
  const scores: Array<1 | 2 | 3 | 4 | 5> = [5, 4, 3, 2, 1];
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => onChange('all')}
        className={cn(
          'h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          value === 'all'
            ? 'bg-foreground text-background'
            : 'bg-muted text-muted-foreground hover:bg-muted/70',
        )}
        aria-pressed={value === 'all'}
      >
        {t('filters.all')}
      </button>
      {scores.map((s) => {
        const active = value === s;
        const color = scoreColorClasses(s, active);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={cn(
              'inline-flex h-6 items-center gap-0.5 rounded-full px-2 text-[11px] font-medium tabular-nums transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              color,
            )}
            aria-pressed={active}
            aria-label={t('filters.score', { n: s })}
          >
            <span>{s}</span>
            <Star className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Color por score y estado. La versión activa usa bg/text fuerte; la
 * inactiva pisa `bg-muted` para mantener uniformidad con el chip "todas".
 */
function scoreColorClasses(score: 1 | 2 | 3 | 4 | 5, active: boolean): string {
  if (!active) return 'bg-muted text-muted-foreground hover:bg-muted/70';
  switch (score) {
    case 5:
      return 'bg-emerald-500 text-white';
    case 4:
      return 'bg-emerald-400 text-white';
    case 3:
      return 'bg-amber-400 text-amber-950';
    case 2:
      return 'bg-orange-400 text-orange-950';
    case 1:
      return 'bg-red-500 text-white';
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *                       FEEDBACK LIST ROW
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Row de la lista izquierda. Sigue el lenguaje de servicios/conversaciones:
 * marker vertical brand cuando activo, jerarquía nombre > meta > snippet.
 * El comentario se muestra truncado a 2 líneas si existe — usar `line-clamp-2`.
 */
function FeedbackListRow({
  item,
  active,
  onSelect,
  locale,
  t,
}: {
  item: FeedbackListItem;
  active: boolean;
  onSelect: () => void;
  locale: string;
  t: ReturnType<typeof useTranslations<'panel.feedback'>>;
}) {
  return (
    <MasterDetailRow
      onSelect={onSelect}
      active={active}
      markerHeight={item.comment ? 'h-14' : 'h-10'}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium text-foreground">
            {item.patientName || t('recent.unnamed')}
          </p>
          <span className="shrink-0">
            <StarBar value={item.score} size="sm" />
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {t('recent.metaLine', {
            professional: item.professionalName,
            service: item.serviceName,
          })}
        </p>
        {item.comment ? (
          <p className="mt-1 line-clamp-2 text-[11px] italic leading-snug text-muted-foreground/90">
            “{item.comment}”
          </p>
        ) : null}
        <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/70">
          {formatRespondedAt(item.respondedAt, locale)}
        </p>
      </div>
    </MasterDetailRow>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                        SIDEBAR EMPTY (0 total)
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Estado cuando no hay ninguna respuesta en total. Va dentro del sidebar
 * (empty compacto) — el panel derecho muestra el dashboard vacío en simultáneo.
 */
function SidebarEmpty({
  t,
}: {
  t: ReturnType<typeof useTranslations<'panel.feedback'>>;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-brand-50">
          <MessageSquareHeart
            className="h-5 w-5 text-brand-600"
            aria-hidden="true"
          />
        </div>
        <p className="text-xs font-medium text-foreground">
          {t('empty.title')}
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                          DASHBOARD PANEL
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Panel derecho en modo "empty" (sin selección). Muestra el dashboard
 * agregado: stats + distribución + ranking por profesional. Es la vista
 * default — el operador ve el resumen antes de bucear en respuestas puntuales.
 *
 * Cuando `summary.count === 0` cambiamos a un empty state con carácter en
 * lugar de mostrar 0s vacíos.
 */
function DashboardPanel({
  summary,
  locale,
}: {
  summary: FeedbackSummary;
  locale: string;
}) {
  const t = useTranslations('panel.feedback');

  const rankedProfessionals = useMemo(() => {
    return [...summary.byProfessional].sort((a, b) => {
      if (b.average !== a.average) return b.average - a.average;
      return b.count - a.count;
    });
  }, [summary.byProfessional]);

  const best = rankedProfessionals[0];

  const positiveRatio = useMemo(() => {
    if (summary.count === 0) return 0;
    const positive = summary.distribution['4'] + summary.distribution['5'];
    return positive / summary.count;
  }, [summary]);

  if (summary.count === 0) {
    return <DashboardEmpty />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-5 lg:p-6">
        {/* Header contextual (mismo lenguaje que header form en servicios) */}
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('panelEmpty.title')}
          </p>
          <h2 className="text-base font-semibold text-foreground">
            {t('distribution.title')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('panelEmpty.description')}
          </p>
        </div>

        {/* Stats grid 2×2 */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            title={t('stats.total.title')}
            hint={t('stats.total.hint')}
            icon={<MessageCircle className="h-4 w-4 text-muted-foreground" />}
            value={summary.count.toString()}
          />
          <StatCard
            title={t('stats.average.title')}
            icon={
              <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            }
            value={
              <span>
                {summary.average.toFixed(1)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  / 5
                </span>
              </span>
            }
            accessory={<StarBar value={summary.average} className="mt-1.5" />}
          />
          <StatCard
            title={t('stats.positive.title')}
            hint={t('stats.positive.hint')}
            icon={
              <MessageSquareHeart className="h-4 w-4 text-emerald-500" />
            }
            value={`${(positiveRatio * 100).toFixed(0)}%`}
          />
          <StatCard
            title={t('stats.top.title')}
            icon={<Users className="h-4 w-4 text-muted-foreground" />}
            value={
              best ? (
                <span className="block truncate text-base font-semibold">
                  {best.professionalName}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {t('stats.top.empty')}
                </span>
              )
            }
            hint={
              best
                ? t('stats.top.hint', {
                    avg: best.average.toFixed(1),
                    count: best.count,
                  })
                : undefined
            }
          />
        </div>

        {/* Distribución */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-foreground">
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

        {/* Ranking por profesional */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-foreground">
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
                    <tr className="border-b text-left text-xs text-muted-foreground">
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

        {/* Sugerencia: los detalles aparecen al hacer click */}
        <p className="pb-2 text-center text-[11px] text-muted-foreground">
          {locale === 'pt'
            ? 'Selecione uma resposta na lista para ver o detalhe.'
            : 'Seleccioná una respuesta en la lista para ver el detalle.'}
        </p>
      </div>
    </div>
  );
}

/**
 * StatCard compacta con jerarquía: icon top-right, título xs muted, valor grande.
 * Extraída para deduplicar los 4 nodos del grid del dashboard.
 */
function StatCard({
  title,
  hint,
  icon,
  value,
  accessory,
}: {
  title: string;
  hint?: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  accessory?: React.ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-1.5">
        <CardTitle className="min-w-0 text-xs font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <span aria-hidden="true">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="min-w-0 text-2xl font-semibold tabular-nums text-foreground">
          {value}
        </div>
        {accessory}
        {hint ? (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                         DASHBOARD EMPTY
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Panel derecho cuando no hay respuestas en total. SVG inline con carácter
 * (globo de chat + estrella + sparkles) — mismo lenguaje que el empty de
 * servicios (reloj estilizado). Evitamos íconos lucide sin contexto.
 */
function DashboardEmpty() {
  const t = useTranslations('panel.feedback');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="relative">
        <svg
          width="140"
          height="140"
          viewBox="0 0 140 140"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="text-brand-600/80"
        >
          {/* Halo suave */}
          <circle cx="70" cy="70" r="60" className="fill-brand-50" />
          {/* Globo de chat con curvatura orgánica */}
          <path
            d="M40 55c0-8 6-14 14-14h32c8 0 14 6 14 14v22c0 8-6 14-14 14H68l-12 10v-10h-2c-8 0-14-6-14-14V55z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
            className="fill-background/60"
          />
          {/* Estrella grande adentro del globo */}
          <path
            d="M70 55l4.2 8.5 9.3 1.4-6.75 6.6 1.6 9.3L70 76.4l-8.35 4.4 1.6-9.3L56.5 64.9l9.3-1.4L70 55z"
            className="fill-amber-400"
            stroke="currentColor"
            strokeWidth="0.5"
          />
          {/* Sparkles decorativos */}
          <path
            d="M112 32l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z"
            className="fill-amber-400"
          />
          <path
            d="M28 100l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
            className="fill-amber-400"
          />
          <path
            d="M108 108l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z"
            className="fill-brand-600/60"
          />
        </svg>
      </div>
      <div className="max-w-sm space-y-1.5">
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

/* ═══════════════════════════════════════════════════════════════════
 *                            DETAIL PANEL
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Panel derecho en modo "detail". Header sticky con nombre paciente + close;
 * body scrollable con score grande, contexto de la cita y comentario destacado.
 *
 * No hay footer con acciones — el feedback es read-only. El close btn del header
 * (X en desktop, ← en mobile) devuelve al dashboard.
 */
function DetailPanel({
  item,
  locale,
  onClose,
}: {
  item: FeedbackListItem;
  locale: string;
  onClose: () => void;
}) {
  const t = useTranslations('panel.feedback');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header sticky — mismo chrome que ServiceForm */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* Back button visible sólo en mobile (< md) para consistencia con Sheet */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 md:hidden"
            onClick={onClose}
            aria-label={t('detail.backLabel')}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('detail.patientLabel')}
            </p>
            <h2 className="truncate text-base font-semibold text-foreground">
              {item.patientName || t('recent.unnamed')}
            </h2>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="hidden h-8 w-8 md:inline-flex"
          onClick={onClose}
          aria-label={t('close')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>

      {/* Body scrollable */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {/* Score hero — estrellas grandes + número + fecha respondida */}
        <section className="rounded-xl border border-border/70 bg-gradient-to-br from-brand-50/60 via-background to-amber-50/40 p-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('detail.sectionScore')}
          </p>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums text-foreground">
              {item.score}
            </span>
            <span className="text-lg text-muted-foreground">/ 5</span>
          </div>
          <div className="mt-3">
            <StarBar value={item.score} size="lg" />
          </div>
          <p className="mt-3 text-xs tabular-nums text-muted-foreground">
            {t('detail.respondedAt', {
              date: formatFullDate(item.respondedAt, locale),
            })}
          </p>
        </section>

        {/* Comment — destacado si existe */}
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('detail.sectionComment')}
          </p>
          {item.comment ? (
            <blockquote className="relative rounded-lg border-l-2 border-brand-500 bg-muted/40 px-4 py-3 text-sm italic leading-relaxed text-foreground/90">
              <span
                aria-hidden="true"
                className="absolute -left-1 top-1 font-serif text-4xl leading-none text-brand-500/50"
              >
                “
              </span>
              <span className="relative">{item.comment}</span>
            </blockquote>
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              {t('detail.noComment')}
            </p>
          )}
        </section>

        {/* Contexto — profesional + servicio + cita */}
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t('detail.sectionContext')}
          </p>
          <div className="rounded-lg border border-border/70 bg-card">
            <ContextRow
              icon={<User className="h-3.5 w-3.5" aria-hidden="true" />}
              label={t('detail.professionalLabel')}
              value={item.professionalName}
            />
            <div className="border-t border-border/60" />
            <ContextRow
              icon={<MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />}
              label={t('detail.serviceLabel')}
              value={item.serviceName}
            />
            <div className="border-t border-border/60" />
            <ContextRow
              icon={
                <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
              }
              label={t('detail.sectionAppointment')}
              value={formatFullDate(item.appointmentStartAt, locale)}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Fila del bloque de contexto — label + value con icono a la izquierda.
 */
function ContextRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-sm font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            SUB-COMPONENTES
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Barra visual de 5 estrellas. `value` puede ser fraccional (ej. 3.7) —
 * cada estrella se llena por su índice: full si idx+1 <= floor, half si
 * el fraccional cae en su rango, vacía si no. `size` controla el tamaño.
 */
function StarBar({
  value,
  className,
  size = 'md',
}: {
  value: number;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const stars = [1, 2, 3, 4, 5];
  const sizeClass =
    size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-5 w-5' : 'h-3.5 w-3.5';
  return (
    <div
      className={cn(
        'flex items-center gap-0.5',
        size === 'lg' ? 'gap-1' : 'gap-0.5',
        className,
      )}
      role="img"
      aria-label={`${value.toFixed(1)} / 5`}
    >
      {stars.map((s) => {
        const filled = value >= s;
        const halfFull = !filled && value > s - 0.5;
        return (
          <Star
            key={s}
            className={cn(
              sizeClass,
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
 * para leer "cuántos 5★ tengo primero"). Barra con transición al mount.
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
                  'h-full rounded-full transition-all duration-500',
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
 * Formato compacto para la lista (dd mmm HH:mm). Usa Intl.DateTimeFormat
 * siguiendo el patrón del resto del panel — NO Luxon (web no la tiene).
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

/**
 * Formato largo para el panel de detalle (weekday + fecha completa + hora).
 */
function formatFullDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
