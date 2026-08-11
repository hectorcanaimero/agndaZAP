'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  buildLeadsQueryString,
  type LeadsListResponse,
  type LeadStatus,
} from '@/lib/api';
import { apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

const STATUS_VALUES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'DEMO',
  'CONVERTED',
  'LOST',
] as const;

/** `__all` es un valor sentinel — Radix Select no acepta `""` como value. */
type StatusFilter = 'all' | LeadStatus;

interface Props {
  locale: string;
  initial: LeadsListResponse;
}

const PAGE_SIZE = 20;

/* ─────────────────────────── Helpers ─────────────────────────── */

/**
 * Traduce el número de WhatsApp a un link `wa.me/` — el owner probablemente
 * quiera contactar directo desde la tabla. Solo dígitos, sin `+`.
 */
function toWaMe(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}`;
}

/**
 * Formato de fecha compacto y localizado. Usamos el locale del panel
 * (mismo que ve el resto de la UI) para consistencia.
 */
function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * Mapa status → variante de color del badge. Reutilizamos las variants
 * shadcn estándar en vez de crear nuevas — el Badge no depende de tokens
 * de citas para estos valores.
 */
function statusVariant(
  status: LeadStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'NEW':
      return 'default'; // brand — recién llegado, requiere atención
    case 'CONTACTED':
      return 'secondary';
    case 'DEMO':
      return 'secondary';
    case 'CONVERTED':
      return 'default';
    case 'LOST':
      return 'outline';
    default:
      return 'outline';
  }
}

/* ═══════════════════════════════════════════════════════════════════
 *                          LEADS CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Fase 1: solo lectura. Filtro por status + paginación cliente-driven.
 *
 * Decisiones de diseño:
 * - Filtro y página viven en `useState` local (no en URL params) para mantener
 *   el diff mínimo. Migrar a `useSearchParams` es trivial cuando aparezca
 *   la necesidad de compartir links a listados filtrados.
 * - El `initial` del server cubre solo el estado inicial (page 1, sin filtro).
 *   Cambiar cualquier param dispara refetch — TanStack Query cachea por
 *   `queryKey` así que volver al estado inicial es instantáneo.
 * - Sin acciones de escritura todavía. El botón "Contactar" abre `wa.me`,
 *   pero el PATCH `status = CONTACTED` es Fase 2.
 */
export function LeadsClient({ locale, initial }: Props) {
  const t = useTranslations('panel.leads');

  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState<number>(1);

  const filters = {
    status: status === 'all' ? undefined : status,
    page,
    pageSize: PAGE_SIZE,
  };

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: queryKeys.leads(filters),
    queryFn: () =>
      apiQuery<LeadsListResponse>(
        `/api/leads?${buildLeadsQueryString(filters)}`,
      ),
    // Solo hidratamos con `initial` cuando el filter/page matchean el fetch SSR
    // (sin filtro y page 1). En cualquier otro caso, dejamos que el cliente
    // haga el fetch fresco.
    initialData:
      status === 'all' && page === 1 ? initial : undefined,
    staleTime: 15_000,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const canPrev = page > 1;
  const canNext = page < totalPages;

  function onStatusChange(v: string) {
    setStatus(v as StatusFilter);
    setPage(1); // Reset a página 1 cuando cambia el filtro.
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar: filtro por status */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label
            htmlFor="lead-status-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            {t('filters.status')}
          </label>
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger
              id="lead-status-filter"
              className="h-9 w-[180px]"
              aria-label={t('filters.status')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filters.all')}</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`status.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-xs tabular-nums text-muted-foreground">
          {isFetching ? (
            <span className="inline-flex items-center gap-1">
              <Sparkles
                className="h-3 w-3 animate-pulse"
                aria-hidden="true"
              />
              {t('loading')}
            </span>
          ) : (
            <span>
              {t('pagination.page', { page, total: totalPages })}
              {' · '}
              {t('countLabel', { n: total })}
            </span>
          )}
        </div>
      </div>

      {/* Body: tabla, empty state, o error */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card">
        {isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-destructive">{t('loadError')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => refetch()}
            >
              {t('retry')}
            </Button>
          </div>
        ) : !data && isFetching ? (
          <LeadsTableSkeleton />
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>{t('table.name')}</TableHead>
                  <TableHead>{t('table.phone')}</TableHead>
                  <TableHead>{t('table.clinicType')}</TableHead>
                  <TableHead>{t('table.locale')}</TableHead>
                  <TableHead>{t('table.createdAt')}</TableHead>
                  <TableHead className="text-right">
                    {t('table.status')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium text-foreground">
                      {lead.name}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <a
                        href={toWaMe(lead.phone)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-700 underline-offset-2 hover:underline"
                      >
                        {lead.phone}
                      </a>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {lead.clinicType ?? '—'}
                    </TableCell>
                    <TableCell className="uppercase text-muted-foreground">
                      {lead.locale}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatDate(lead.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={statusVariant(lead.status)}
                        className={cn('text-[10px]')}
                      >
                        {t(`status.${lead.status}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Footer: paginación */}
      {items.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="text-xs tabular-nums text-muted-foreground">
            {t('pagination.page', { page, total: totalPages })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canPrev || isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="gap-1"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('pagination.prev')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canNext || isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="gap-1"
            >
              {t('pagination.next')}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

function EmptyState() {
  const t = useTranslations('panel.leads');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <Sparkles className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="max-w-xs space-y-1.5">
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

/**
 * Skeleton estilo tabla — muestra 5 filas. Solo se ve durante el primer fetch
 * cuando no hay `initialData` (o sea, al cambiar de filtro sin cache previo).
 */
function LeadsTableSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="ml-auto h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
