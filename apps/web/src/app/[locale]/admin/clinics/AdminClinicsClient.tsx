'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Eye,
  LogIn,
  Search,
  Sparkles,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  buildAdminClinicsQuery,
  type AdminClinicsFilters,
  type AdminClinicsListResponse,
  type ClinicStatus,
  type ImpersonateResponse,
} from '@/lib/admin';
import { startImpersonation } from '@/lib/auth';
import { apiMutation, apiQuery, ApiError } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { CreateClinicDialog } from './CreateClinicDialog';

const PAGE_SIZE = 20;

const STATUS_VALUES: readonly ClinicStatus[] = [
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
] as const;

type StatusFilter = 'all' | ClinicStatus;

interface Props {
  locale: string;
  initial: AdminClinicsListResponse;
}

/**
 * Pinta el badge de status con contraste AA:
 * - ACTIVE → verde suave sobre fondo blanco.
 * - SUSPENDED → amber (mismo tono que el ImpersonationBanner para consistencia).
 * - ARCHIVED → gris — señal "no operativa" sin alarma.
 */
function statusVariant(
  status: ClinicStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'SUSPENDED':
      return 'destructive';
    case 'ARCHIVED':
      return 'outline';
  }
}

/**
 * AdminClinicsClient — listado paginado de clínicas para el SUPERADMIN.
 *
 * Fase MVP: filtros básicos (status + search), acción "Impersonar" inline en la
 * tabla, y link al detalle. La creación de clínicas (`POST /admin/clinics`) no
 * está en la UI todavía — se hace vía CLI o SQL directo por ahora.
 *
 * Búsqueda con debounce corto (300ms) para no dispararla en cada tecla — es
 * un LIKE cross-tenant, no queremos golpear la DB en cada carácter.
 */
export function AdminClinicsClient({ locale, initial }: Props) {
  const t = useTranslations('admin.clinics');
  const tImp = useTranslations('impersonation');

  const [status, setStatus] = useState<StatusFilter>('all');
  const [searchInput, setSearchInput] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [page, setPage] = useState<number>(1);

  // Debounce del search: 300ms. Evita hacer 8 requests si el operador escribe
  // "González" carácter por carácter. También resetea a page 1.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const filters: AdminClinicsFilters = useMemo(
    () => ({
      status: status === 'all' ? undefined : status,
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [status, search, page],
  );

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: queryKeys.admin.clinics(filters),
    queryFn: () =>
      apiQuery<AdminClinicsListResponse>(
        `/api/admin/clinics?${buildAdminClinicsQuery(filters)}`,
      ),
    // Hidratamos con `initial` solo cuando el filtro/página matchean el SSR.
    initialData:
      status === 'all' && search === '' && page === 1 ? initial : undefined,
    staleTime: 15_000,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const impersonate = useMutation({
    mutationFn: (clinicId: string) =>
      apiMutation<ImpersonateResponse>(
        `/api/admin/clinics/${clinicId}/impersonate`,
        'POST',
      ),
    onSuccess: (res) => {
      // 1. Backup del super_jwt + swap por imp_jwt.
      startImpersonation(res.token);
      // 2. Toast informativo (persiste tras navegar por sonner).
      toast.success(tImp('toasts.started', { name: res.clinic.name }));
      // 3. Redirect al panel de la clínica impersonada.
      window.location.href = `/${locale}/panel/dashboard`;
    },
    onError: (err) => {
      // 400 = clínica no-ACTIVE. Cualquier otro = genérico.
      if (err instanceof ApiError && err.status === 400) {
        toast.error(tImp('errors.cannotImpersonateNonActive'));
      } else {
        toast.error(tImp('errors.startFailed'));
      }
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Building2
              className="h-5 w-5 text-amber-600"
              aria-hidden="true"
              strokeWidth={2.25}
            />
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <CreateClinicDialog locale={locale} />
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('filters.search')}
            aria-label={t('filters.search')}
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="admin-clinic-status-filter"
            className="text-xs font-medium text-muted-foreground"
          >
            {t('filters.status')}
          </label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as StatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger
              id="admin-clinic-status-filter"
              className="h-9 w-[160px]"
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
              {t('count', { n: total })}
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
            <Building2
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
                  <TableHead>{t('table.name')}</TableHead>
                  <TableHead>{t('table.slug')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead className="text-right">
                    {t('table.professionals')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('table.appointments')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('table.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((clinic) => (
                  <TableRow key={clinic.id}>
                    <TableCell className="font-medium text-foreground">
                      <Link
                        href={`/${locale}/admin/clinics/${clinic.id}`}
                        className="hover:underline"
                      >
                        {clinic.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {clinic.slug}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant(clinic.status)}
                        className={cn('text-[10px]')}
                      >
                        {t(`status.${clinic.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {clinic._count.professionals}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {clinic._count.appointments}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          asChild
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 px-2 text-xs"
                        >
                          <Link
                            href={`/${locale}/admin/clinics/${clinic.id}`}
                          >
                            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">
                              {t('table.viewDetail')}
                            </span>
                          </Link>
                        </Button>
                        {clinic.status === 'ACTIVE' ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 px-2 text-xs"
                            disabled={
                              impersonate.isPending &&
                              impersonate.variables === clinic.id
                            }
                            onClick={() => impersonate.mutate(clinic.id)}
                          >
                            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">
                              {t('actions.impersonate')}
                            </span>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
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
