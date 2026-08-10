'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  Plus,
  Search,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

interface BusinessHour {
  id: string;
  weekday: number;
  startMinutes: number;
  endMinutes: number;
  professionalId: string | null;
}

interface ProfessionalLite {
  id: string;
  name: string;
}

interface Props {
  hours: BusinessHour[];
  professionals: ProfessionalLite[];
}

const bhSchema = z
  .object({
    weekday: z.coerce.number().int().min(0).max(6),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    professionalId: z.string().optional(),
  })
  .refine((v) => toMinutes(v.endTime) > toMinutes(v.startTime), {
    message: 'endTime > startTime',
    path: ['endTime'],
  });

type BhFormValues = z.infer<typeof bhSchema>;

type PanelMode =
  | { kind: 'empty' }
  | { kind: 'create' }
  | { kind: 'edit'; row: BusinessHour };

/* ─────────────────────────── Helpers ─────────────────────────── */

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// Orden de la semana en la vista: L, M, X, J, V, S, D. Corresponde a weekday
// 1..6, 0 al final. El schema usa 0=domingo (Prisma standard).
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/* ═══════════════════════════════════════════════════════════════════
 *                      BUSINESS HOURS CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Master-detail 2-col con agrupamiento visual por día de la semana.
 *
 * Diferencia vs servicios/profesionales: BusinessHour es una entidad "matricial"
 * (7 días × N profesionales). Una lista plana no comunica bien — el operador
 * necesita ver rápido "los lunes qué pasa". Solución: sticky headers por
 * weekday, con las rows del día agrupadas debajo (ordenadas por startMinutes).
 *
 * Toolbar tiene filtro de profesional (o "toda la clínica") para achicar el
 * scope cuando hay muchos profesionales.
 */
export function BusinessHoursClient({
  hours: initialHours,
  professionals,
}: Props) {
  const t = useTranslations('panel.businessHours');
  const qc = useQueryClient();

  const [profFilter, setProfFilter] = useState<string>('__all');
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const [deleteTarget, setDeleteTarget] = useState<BusinessHour | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const { data: hours = initialHours } = useQuery({
    queryKey: queryKeys.businessHours(),
    queryFn: () => apiQuery<BusinessHour[]>('/api/business-hours'),
    initialData: initialHours,
    staleTime: 30_000,
  });

  const weekdayLabels = useMemo(
    () => [
      t('weekdays.0'),
      t('weekdays.1'),
      t('weekdays.2'),
      t('weekdays.3'),
      t('weekdays.4'),
      t('weekdays.5'),
      t('weekdays.6'),
    ],
    [t],
  );

  function profName(id: string | null): string {
    if (!id) return t('allProfessionals');
    return professionals.find((p) => p.id === id)?.name ?? id;
  }

  // Filtro por profesional. '__all' muestra todo. '__clinic' (opcional futuro)
  // podría mostrar solo los sin professionalId — hoy no separado.
  const filtered = useMemo(() => {
    if (profFilter === '__all') return hours;
    if (profFilter === '__clinic') return hours.filter((h) => !h.professionalId);
    return hours.filter((h) => h.professionalId === profFilter);
  }, [hours, profFilter]);

  // Agrupamos por weekday, cada grupo ordenado por startMinutes.
  const grouped = useMemo(() => {
    const map = new Map<number, BusinessHour[]>();
    for (const h of filtered) {
      const bucket = map.get(h.weekday) ?? [];
      bucket.push(h);
      map.set(h.weekday, bucket);
    }
    for (const [, bucket] of map) {
      bucket.sort((a, b) => a.startMinutes - b.startMinutes);
    }
    // Devolvemos en orden L-D según WEEK_ORDER, saltando días vacíos.
    return WEEK_ORDER.map((w) => ({
      weekday: w,
      rows: map.get(w) ?? [],
    })).filter((g) => g.rows.length > 0);
  }, [filtered]);

  const activeId = panel.kind === 'edit' ? panel.row.id : null;

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/business-hours/${id}`, 'DELETE'),
    onSuccess: (_data, deletedId) => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: ['businessHours'] });
      if (panel.kind === 'edit' && panel.row.id === deletedId) {
        setPanel({ kind: 'empty' });
        setMobileSheetOpen(false);
      }
    },
    onError: () => {
      toast.error(t('deleteFailed'));
    },
    onSettled: () => setDeleteTarget(null),
  });

  function isMobileViewport(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767.98px)').matches;
  }

  function openCreate() {
    setPanel({ kind: 'create' });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function openEdit(r: BusinessHour) {
    setPanel({ kind: 'edit', row: r });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    setMobileSheetOpen(false);
  }

  function handleFormSuccess(saved: BusinessHour, wasCreate: boolean) {
    setPanel({ kind: 'edit', row: saved });
    if (wasCreate) setMobileSheetOpen(false);
  }

  const panelContent =
    panel.kind === 'empty' ? (
      <EmptyPanel onCreate={openCreate} />
    ) : (
      <BusinessHourForm
        key={panel.kind === 'edit' ? panel.row.id : 'new'}
        mode={panel}
        professionals={professionals}
        onClose={closePanel}
        onSuccess={handleFormSuccess}
        onDelete={(r) => setDeleteTarget(r)}
        weekdayLabels={weekdayLabels}
      />
    );

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* ─────────  IZQUIERDA — LISTA AGRUPADA  ───────── */}
        <aside className="flex min-h-0 w-full flex-col border-r border-border/60 md:w-[380px] md:shrink-0">
          <div className="shrink-0 space-y-2 border-b border-border/60 p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Select value={profFilter} onValueChange={setProfFilter}>
                  <SelectTrigger className="h-9 pl-8" aria-label={t('filterProfessional')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">{t('filters.allRows')}</SelectItem>
                    <SelectItem value="__clinic">
                      {t('filters.clinicOnly')}
                    </SelectItem>
                    {professionals.length > 0 ? (
                      <>
                        <div className="my-1 border-t border-border" />
                        {professionals.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                className="h-9 shrink-0 gap-1.5"
                onClick={openCreate}
                aria-label={t('new')}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t('new')}</span>
              </Button>
            </div>
            <p className="px-0.5 text-[11px] tabular-nums text-muted-foreground">
              {t('countLabel', { n: hours.length })}
              {profFilter !== '__all' && filtered.length !== hours.length ? (
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

          {grouped.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">
                  {profFilter !== '__all' ? t('noFilterResults') : t('emptyList')}
                </p>
                {profFilter === '__all' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={openCreate}
                  >
                    <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {t('createFirst')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {grouped.map((group) => (
                <section key={group.weekday}>
                  <h3 className="sticky top-0 z-10 flex items-center justify-between border-b border-border/40 bg-card/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                    <span>{weekdayLabels[group.weekday]}</span>
                    <span className="tabular-nums">
                      {group.rows.length}
                    </span>
                  </h3>
                  <ul className="space-y-0.5 p-1">
                    {group.rows.map((r) => (
                      <li key={r.id}>
                        <BusinessHourRow
                          row={r}
                          active={r.id === activeId}
                          onSelect={() => openEdit(r)}
                          profName={profName}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </aside>

        {/* ─────────  DERECHA — PANEL (solo md+)  ───────── */}
        <section className="hidden min-h-0 flex-1 md:flex md:flex-col">
          {panelContent}
        </section>
      </div>

      {/* ─────────  MOBILE — SHEET DRAWER  ───────── */}
      <Sheet
        open={mobileSheetOpen}
        onOpenChange={(o) => {
          if (!o) closePanel();
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto p-0 sm:max-w-md md:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>
              {panel.kind === 'create'
                ? t('newTitle')
                : panel.kind === 'edit'
                  ? t('editTitle')
                  : ''}
            </SheetTitle>
          </SheetHeader>
          {panel.kind !== 'empty' ? panelContent : null}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        title={t('confirmDelete.title')}
        description={t.rich('confirmDelete.description', {
          name: () =>
            deleteTarget ? (
              <strong className="font-semibold text-foreground">
                {weekdayLabels[deleteTarget.weekday]}{' '}
                {toHHMM(deleteTarget.startMinutes)}–
                {toHHMM(deleteTarget.endMinutes)} ·{' '}
                {profName(deleteTarget.professionalId)}
              </strong>
            ) : null,
          warn: (chunks) => (
            <strong className="font-semibold text-destructive">{chunks}</strong>
          ),
        })}
        confirmLabel={t('delete')}
        variant="destructive"
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                        BUSINESS HOUR ROW
 * ═══════════════════════════════════════════════════════════════════ */

function BusinessHourRow({
  row: r,
  active,
  onSelect,
  profName,
}: {
  row: BusinessHour;
  active: boolean;
  onSelect: () => void;
  profName: (id: string | null) => string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand-50 text-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-2.5 h-8 w-0.5 rounded-r-full bg-brand-600"
        />
      ) : null}
      <Clock
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tabular-nums text-foreground">
          {toHHMM(r.startMinutes)} – {toHHMM(r.endMinutes)}
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
          <User className="h-3 w-3" aria-hidden="true" />
          {profName(r.professionalId)}
        </p>
      </div>
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            EMPTY PANEL
 * ═══════════════════════════════════════════════════════════════════ */

function EmptyPanel({ onCreate }: { onCreate: () => void }) {
  const t = useTranslations('panel.businessHours');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="relative">
        <svg
          width="120"
          height="120"
          viewBox="0 0 120 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="text-brand-600/80"
        >
          <circle cx="60" cy="60" r="52" className="fill-brand-50" />
          {/* Reloj + agenda estilizados */}
          <circle
            cx="60"
            cy="60"
            r="28"
            stroke="currentColor"
            strokeWidth="1.5"
            className="opacity-50"
          />
          {/* Manecillas */}
          <path
            d="M60 44v16l10 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Marcadores 12/3/6/9 */}
          {[0, 90, 180, 270].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const x1 = 60 + Math.sin(rad) * 24;
            const y1 = 60 - Math.cos(rad) * 24;
            const x2 = 60 + Math.sin(rad) * 28;
            const y2 = 60 - Math.cos(rad) * 28;
            return (
              <line
                key={deg}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="opacity-50"
              />
            );
          })}
          {/* Sparkle */}
          <path
            d="M96 34l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
            className="fill-amber-400"
          />
        </svg>
      </div>
      <div className="max-w-xs space-y-1.5">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {t('empty.title')}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('empty.description')}
        </p>
      </div>
      <Button onClick={onCreate} className="mt-2 gap-1.5">
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('empty.cta')}
      </Button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                        BUSINESS HOUR FORM
 * ═══════════════════════════════════════════════════════════════════ */

function BusinessHourForm({
  mode,
  professionals,
  onClose,
  onSuccess,
  onDelete,
  weekdayLabels,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; row: BusinessHour };
  professionals: ProfessionalLite[];
  onClose: () => void;
  onSuccess: (saved: BusinessHour, wasCreate: boolean) => void;
  onDelete: (r: BusinessHour) => void;
  weekdayLabels: string[];
}) {
  const t = useTranslations('panel.businessHours');
  const qc = useQueryClient();
  const isEdit = mode.kind === 'edit';
  const row = isEdit ? mode.row : null;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<BhFormValues>({
    resolver: zodResolver(bhSchema),
    defaultValues: {
      weekday: row?.weekday ?? 1,
      startTime: row ? toHHMM(row.startMinutes) : '09:00',
      endTime: row ? toHHMM(row.endMinutes) : '18:00',
      professionalId: row?.professionalId ?? '',
    },
  });

  useEffect(() => {
    reset({
      weekday: row?.weekday ?? 1,
      startTime: row ? toHHMM(row.startMinutes) : '09:00',
      endTime: row ? toHHMM(row.endMinutes) : '18:00',
      professionalId: row?.professionalId ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const weekday = watch('weekday');
  const professionalId = watch('professionalId');
  const startTime = watch('startTime');
  const endTime = watch('endTime');

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!isEdit) {
        return apiMutation<BusinessHour, Record<string, unknown>>(
          '/api/business-hours',
          'POST',
          payload,
        );
      }
      return apiMutation<BusinessHour, Record<string, unknown>>(
        `/api/business-hours/${row!.id}`,
        'PATCH',
        payload,
      );
    },
    onSuccess: (saved) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['businessHours'] });
      onSuccess(saved, !isEdit);
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: BhFormValues) {
    const payload = {
      weekday: values.weekday,
      startMinutes: toMinutes(values.startTime),
      endMinutes: toMinutes(values.endTime),
      ...(values.professionalId
        ? { professionalId: values.professionalId }
        : {}),
    };
    await saveMutation.mutateAsync(payload).catch(() => undefined);
  }

  const busy = saveMutation.isPending;

  // Preview del rango en horas — ayuda visual antes de guardar.
  const durationMinutes =
    startTime && endTime ? toMinutes(endTime) - toMinutes(startTime) : 0;

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex h-full min-h-0 flex-col"
      noValidate
    >
      {/* Header sticky */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {isEdit ? t('editTitle') : t('newTitle')}
          </p>
          <h2 className="truncate text-base font-semibold text-foreground">
            {isEdit
              ? `${weekdayLabels[row!.weekday]} · ${toHHMM(row!.startMinutes)}–${toHHMM(row!.endMinutes)}`
              : t('newSubtitle')}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onDelete(row!)}
              aria-label={t('delete')}
              disabled={busy}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            aria-label={t('close')}
            disabled={busy}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* Body scrollable */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="bh-weekday">{t('fields.weekday')}</Label>
          <Select
            value={String(weekday)}
            onValueChange={(v) =>
              setValue('weekday', Number(v), {
                shouldValidate: true,
                shouldDirty: true,
              })
            }
            disabled={busy}
          >
            <SelectTrigger id="bh-weekday">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEK_ORDER.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {weekdayLabels[w]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="bh-start" className="flex items-center gap-1.5">
              <Clock
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              {t('fields.start')}
            </Label>
            <Input
              id="bh-start"
              type="time"
              {...register('startTime')}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bh-end">{t('fields.end')}</Label>
            <Input
              id="bh-end"
              type="time"
              {...register('endTime')}
              disabled={busy}
            />
            {errors.endTime ? (
              <p className="text-xs text-destructive">
                {t('errors.rangeInvalid')}
              </p>
            ) : null}
          </div>
        </div>

        {durationMinutes > 0 ? (
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {t('durationHint', {
              hours: Math.floor(durationMinutes / 60),
              minutes: durationMinutes % 60,
            })}
          </p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="bh-prof" className="flex items-center gap-1.5">
            <User
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {t('fields.professional')}
          </Label>
          <Select
            value={professionalId ? professionalId : '__all'}
            onValueChange={(v) =>
              setValue('professionalId', v === '__all' ? '' : v, {
                shouldValidate: true,
                shouldDirty: true,
              })
            }
            disabled={busy}
          >
            <SelectTrigger id="bh-prof">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">{t('allProfessionals')}</SelectItem>
              {professionals.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {t('hints.professional')}
          </p>
        </div>
      </div>

      {/* Footer sticky */}
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={busy}
        >
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy || (isEdit && !isDirty)}
          className="min-w-[100px]"
        >
          {busy ? (
            <>
              <Sparkles
                className="mr-1.5 h-3.5 w-3.5 animate-pulse"
                aria-hidden="true"
              />
              {t('saving')}
            </>
          ) : (
            t('save')
          )}
        </Button>
      </footer>
    </form>
  );
}
