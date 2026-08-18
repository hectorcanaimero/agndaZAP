'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Sparkles,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  buildAdminAuditQuery,
  type AdminAction,
  type AdminAuditFilters,
  type AdminAuditListResponse,
} from '@/lib/admin';
import { apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

const ACTION_VALUES: readonly AdminAction[] = [
  'CREATE_CLINIC',
  'UPDATE_CLINIC',
  'SUSPEND_CLINIC',
  'REACTIVATE_CLINIC',
  'ARCHIVE_CLINIC',
  'START_IMPERSONATION',
] as const;

type ActionFilter = 'all' | AdminAction;

interface Props {
  locale: string;
  initial: AdminAuditListResponse;
}

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

function actionBadgeVariant(
  action: AdminAction,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (action) {
    case 'SUSPEND_CLINIC':
    case 'ARCHIVE_CLINIC':
      return 'destructive';
    case 'START_IMPERSONATION':
      return 'default';
    case 'REACTIVATE_CLINIC':
    case 'CREATE_CLINIC':
      return 'secondary';
    default:
      return 'outline';
  }
}

/**
 * AdminAuditClient — trail read-only del SaaS Admin.
 *
 * Filtros básicos: action, targetType. IDs (actorUserId/targetId) por ahora
 * quedan fuera del UI — el operador puede filtrar por action y encontrar lo
 * que busca. Si aparece necesidad de filtrar por ID concreto, agregar un
 * input de texto — ya lo soporta el backend.
 *
 * pageSize = 50 matchea el default del backend. La UI ofrece paginación
 * manual; no scroll infinito (para poder linkear a páginas específicas si
 * hace falta más adelante).
 */
export function AdminAuditClient({ locale, initial }: Props) {
  const t = useTranslations('admin.audit');

  const [action, setAction] = useState<ActionFilter>('all');
  const [targetType, setTargetType] = useState<string>('all');
  const [page, setPage] = useState<number>(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters: AdminAuditFilters = useMemo(
    () => ({
      action: action === 'all' ? undefined : action,
      targetType: targetType === 'all' ? undefined : targetType,
      page,
      pageSize: PAGE_SIZE,
    }),
    [action, targetType, page],
  );

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: queryKeys.admin.audit(filters),
    queryFn: () =>
      apiQuery<AdminAuditListResponse>(
        `/api/admin/audit?${buildAdminAuditQuery(filters)}`,
      ),
    initialData:
      action === 'all' && targetType === 'all' && page === 1
        ? initial
        : undefined,
    staleTime: 10_000,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  // Derivamos los targetTypes únicos de la página actual como opciones del
  // filtro. En una base grande esto es limitado — el operador puede necesitar
  // filtrar por un type que no está en la página; en ese caso hay que agregar
  // un input libre.
  const targetTypeOptions = useMemo(() => {
    const set = new Set(items.map((i) => i.targetType));
    return Array.from(set).sort();
  }, [items]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ClipboardList
            className="h-5 w-5 text-amber-600"
            aria-hidden="true"
            strokeWidth={2.25}
          />
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label
            htmlFor="audit-action-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            {t('filters.action')}
          </label>
          <Select
            value={action}
            onValueChange={(v) => {
              setAction(v as ActionFilter);
              setPage(1);
            }}
          >
            <SelectTrigger
              id="audit-action-filter"
              className="h-9 w-[220px]"
              aria-label={t('filters.action')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filters.all')}</SelectItem>
              {ACTION_VALUES.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`action.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {targetTypeOptions.length > 0 ? (
          <div className="flex items-center gap-2">
            <label
              htmlFor="audit-target-filter"
              className="text-xs font-medium text-muted-foreground"
            >
              {t('filters.targetType')}
            </label>
            <Select
              value={targetType}
              onValueChange={(v) => {
                setTargetType(v);
                setPage(1);
              }}
            >
              <SelectTrigger
                id="audit-target-filter"
                className="h-9 w-[160px]"
                aria-label={t('filters.targetType')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('filters.all')}</SelectItem>
                {targetTypeOptions.map((tt) => (
                  <SelectItem key={tt} value={tt}>
                    {tt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {(action !== 'all' || targetType !== 'all') && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setAction('all');
              setTargetType('all');
              setPage(1);
            }}
          >
            {t('filters.reset')}
          </Button>
        )}

        <div className="ml-auto text-xs tabular-nums text-muted-foreground">
          {isFetching ? (
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3 animate-pulse" aria-hidden="true" />
              {t('loading')}
            </span>
          ) : (
            <span>
              {t('pagination.page', { page, total: totalPages })}
              {' · '}
              {total}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
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
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <ClipboardList
              className="h-8 w-8 text-muted-foreground/70"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-[180px]">{t('table.when')}</TableHead>
                  <TableHead>{t('table.actor')}</TableHead>
                  <TableHead className="w-[200px]">
                    {t('table.action')}
                  </TableHead>
                  <TableHead>{t('table.target')}</TableHead>
                  <TableHead className="w-[110px]">{t('table.ip')}</TableHead>
                  <TableHead className="w-[70px] text-right">
                    {t('table.metadata')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => {
                  const isExpanded = expandedId === row.id;
                  const target =
                    row.targetType === 'Clinic' && row.targetId ? (
                      <Link
                        href={`/${locale}/admin/clinics/${row.targetId}`}
                        className="text-brand-700 hover:underline"
                      >
                        {row.targetType} · {row.targetId.slice(0, 8)}…
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {row.targetType}
                        {row.targetId ? ` · ${row.targetId.slice(0, 8)}…` : ''}
                      </span>
                    );
                  return (
                    <Fragment key={row.id}>
                      <TableRow>
                        <TableCell className="whitespace-nowrap tabular-nums text-xs text-muted-foreground">
                          {formatDate(row.createdAt, locale)}
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.actor ? (
                            <div className="flex flex-col">
                              <span className="text-foreground">
                                {row.actor.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {row.actor.email}
                              </span>
                            </div>
                          ) : (
                            <span className="font-mono text-xs text-muted-foreground">
                              {row.actorUserId.slice(0, 8)}…
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={actionBadgeVariant(row.action)}
                            className={cn('text-[10px]')}
                          >
                            {t(`action.${row.action}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{target}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {row.ip ?? '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.metadata &&
                          Object.keys(row.metadata).length > 0 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              aria-expanded={isExpanded}
                              aria-label={t('showMetadata')}
                              onClick={() =>
                                setExpandedId(isExpanded ? null : row.id)
                              }
                            >
                              {isExpanded ? (
                                <ChevronUp
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              ) : (
                                <ChevronDown
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              )}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded &&
                      row.metadata &&
                      Object.keys(row.metadata).length > 0 ? (
                        <TableRow className="bg-muted/40">
                          <TableCell colSpan={6} className="py-3">
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card px-3 py-2 text-[11px] leading-relaxed text-foreground">
                              {JSON.stringify(row.metadata, null, 2)}
                            </pre>
                            {row.userAgent ? (
                              <p className="mt-2 truncate text-[11px] text-muted-foreground">
                                <span className="font-medium">User-Agent:</span>{' '}
                                {row.userAgent}
                              </p>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canPrev || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canNext || isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
