'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  LogIn,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type {
  AdminClinicDetail,
  ClinicStatus,
  ImpersonateResponse,
} from '@/lib/admin';
import { startImpersonation } from '@/lib/auth';
import { apiMutation, apiQuery, ApiError } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

interface Props {
  locale: string;
  clinicId: string;
  initial: AdminClinicDetail;
}

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

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
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

function formatPercent(v: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(v);
}

/**
 * AdminClinicDetailClient — vista completa de una clínica con acciones del
 * ciclo de vida (suspend/reactivate/impersonate).
 *
 * WHY:
 * - Ver detalle y actuar en la MISMA vista evita el "context switching" del
 *   super entre listado y detalle mientras diagnostica.
 * - `suspend` requiere motivo obligatorio (queda en `AdminAudit`) — usamos
 *   Dialog con Textarea en vez de un prompt() para forzar validación.
 * - `reactivate` no requiere motivo — es una acción de recuperación, no
 *   restrictiva; usamos ConfirmDialog liviano.
 */
export function AdminClinicDetailClient({ locale, clinicId, initial }: Props) {
  const t = useTranslations('admin.clinics');
  const tImp = useTranslations('impersonation');
  const qc = useQueryClient();

  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspendReasonError, setSuspendReasonError] = useState<string | null>(
    null,
  );
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const { data } = useQuery({
    queryKey: queryKeys.admin.clinic(clinicId),
    queryFn: () =>
      apiQuery<AdminClinicDetail>(`/api/admin/clinics/${clinicId}`),
    initialData: initial,
    staleTime: 15_000,
  });

  const detail = data ?? initial;
  const { clinic, metrics } = detail;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: queryKeys.admin.clinic(clinicId) });
    qc.invalidateQueries({ queryKey: ['admin', 'clinics'] });
  };

  const suspend = useMutation({
    mutationFn: (reason: string) =>
      apiMutation<{ id: string }, { reason: string }>(
        `/api/admin/clinics/${clinicId}/suspend`,
        'POST',
        { reason },
      ),
    onSuccess: () => {
      toast.success(t('toasts.suspended'));
      setSuspendOpen(false);
      setSuspendReason('');
      setSuspendReasonError(null);
      invalidate();
    },
    onError: () => {
      toast.error(t('toasts.suspendError'));
    },
  });

  const reactivate = useMutation({
    mutationFn: () =>
      apiMutation<{ id: string }>(
        `/api/admin/clinics/${clinicId}/reactivate`,
        'POST',
      ),
    onSuccess: () => {
      toast.success(t('toasts.reactivated'));
      setReactivateOpen(false);
      invalidate();
    },
    onError: () => {
      toast.error(t('toasts.reactivateError'));
    },
  });

  const impersonate = useMutation({
    mutationFn: () =>
      apiMutation<ImpersonateResponse>(
        `/api/admin/clinics/${clinicId}/impersonate`,
        'POST',
      ),
    onSuccess: (res) => {
      startImpersonation(res.token);
      toast.success(tImp('toasts.started', { name: res.clinic.name }));
      window.location.href = `/${locale}/panel/dashboard`;
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 400) {
        toast.error(tImp('errors.cannotImpersonateNonActive'));
      } else {
        toast.error(tImp('errors.startFailed'));
      }
    },
  });

  function handleSuspendSubmit() {
    const reason = suspendReason.trim();
    if (reason.length < 3) {
      setSuspendReasonError(t('suspendDialog.reasonError'));
      return;
    }
    setSuspendReasonError(null);
    suspend.mutate(reason);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      {/* Back + title */}
      <div className="flex flex-col gap-3">
        <Link
          href={`/${locale}/admin/clinics`}
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('detail.back')}
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Building2
                className="h-5 w-5 text-amber-600"
                aria-hidden="true"
                strokeWidth={2.25}
              />
              {clinic.name}
              <Badge
                variant={statusVariant(clinic.status)}
                className="ml-1 text-[10px]"
              >
                {t(`status.${clinic.status}`)}
              </Badge>
            </h1>
            <p className="font-mono text-xs text-muted-foreground">
              {clinic.slug}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {clinic.status === 'ACTIVE' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => impersonate.mutate()}
                  disabled={impersonate.isPending}
                >
                  <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('actions.impersonate')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setSuspendOpen(true)}
                >
                  <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('actions.suspend')}
                </Button>
              </>
            ) : null}
            {clinic.status === 'SUSPENDED' ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                className="gap-1.5"
                onClick={() => setReactivateOpen(true)}
              >
                <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                {t('actions.reactivate')}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Suspended notice */}
        {clinic.status === 'SUSPENDED' && clinic.suspendedAt ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              {t('detail.suspendedNotice', {
                date: formatDate(clinic.suspendedAt, locale),
                reason: clinic.suspendedReason ?? '—',
              })}
            </p>
          </div>
        ) : null}
      </div>

      {/* Metrics cards */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <MetricCard
          label={t('detail.metrics.professionals')}
          value={metrics.professionals}
        />
        <MetricCard
          label={t('detail.metrics.servicesActive')}
          value={metrics.servicesActive}
        />
        <MetricCard
          label={t('detail.metrics.appointmentsLast30d')}
          value={metrics.appointmentsLast30d}
        />
        <MetricCard
          label={t('detail.metrics.noShowRateLast30d')}
          value={formatPercent(metrics.noShowRateLast30d, locale)}
          highlight={metrics.noShowRateLast30d >= 0.15}
        />
        <MetricCard
          label={t('detail.metrics.patients')}
          value={metrics.patients}
        />
      </section>

      {/* Info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{clinic.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
            <InfoRow label={t('detail.info.slug')} value={clinic.slug} mono />
            <InfoRow
              label={t('detail.info.timezone')}
              value={clinic.timezone}
              mono
            />
            <InfoRow
              label={t('detail.info.locale')}
              value={clinic.locale.toUpperCase()}
            />
            <InfoRow
              label={t('detail.info.wahaSession')}
              value={clinic.wahaSession}
              mono
            />
            <InfoRow
              label={t('detail.info.address')}
              value={clinic.address ?? '—'}
              full
            />
            {clinic.suspendedAt ? (
              <>
                <InfoRow
                  label={t('detail.info.suspendedAt')}
                  value={formatDate(clinic.suspendedAt, locale)}
                />
                <InfoRow
                  label={t('detail.info.suspendedReason')}
                  value={clinic.suspendedReason ?? '—'}
                  full
                />
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {/* Suspend dialog */}
      <Dialog
        open={suspendOpen}
        onOpenChange={(next) => {
          if (!next && !suspend.isPending) setSuspendOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('suspendDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('suspendDialog.description', { name: clinic.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="suspend-reason">
              {t('suspendDialog.reasonLabel')}
            </Label>
            <Textarea
              id="suspend-reason"
              value={suspendReason}
              onChange={(e) => {
                setSuspendReason(e.target.value);
                if (suspendReasonError) setSuspendReasonError(null);
              }}
              placeholder={t('suspendDialog.reasonPlaceholder')}
              rows={4}
              maxLength={500}
              disabled={suspend.isPending}
              aria-invalid={suspendReasonError ? true : undefined}
            />
            {suspendReasonError ? (
              <p className="text-xs text-destructive">{suspendReasonError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSuspendOpen(false)}
              disabled={suspend.isPending}
            >
              {t('suspendDialog.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleSuspendSubmit}
              disabled={suspend.isPending}
            >
              {suspend.isPending ? '…' : t('suspendDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reactivate confirm */}
      <ConfirmDialog
        open={reactivateOpen}
        onClose={() => setReactivateOpen(false)}
        onConfirm={async () => {
          await reactivate.mutateAsync();
        }}
        title={t('reactivateDialog.title')}
        description={
          <p>{t('reactivateDialog.description', { name: clinic.name })}</p>
        }
        confirmLabel={t('reactivateDialog.submit')}
        cancelLabel={t('reactivateDialog.cancel')}
      />
    </div>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

function MetricCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string | number;
  /** Cuando true pinta el valor con acento amber (ej: no-show alto). */
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums text-foreground',
            highlight && 'text-amber-700',
          )}
        >
          {value}
        </span>
        {highlight ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {/* umbral hardcoded 15% — matchea con el threshold usado en el
                dashboard del panel de clínica. */}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
  full = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', full && 'md:col-span-2')}>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          'text-sm text-foreground',
          mono && 'font-mono text-xs',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

