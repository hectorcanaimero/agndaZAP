'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarOff,
  FileText,
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

interface TimeOff {
  id: string;
  startAt: string;
  endAt: string;
  reason: string | null;
  professionalId: string | null;
}

interface ProfessionalLite {
  id: string;
  name: string;
}

interface Props {
  locale: string;
  rows: TimeOff[];
  professionals: ProfessionalLite[];
}

const toffSchema = z
  .object({
    startAt: z.string().min(1),
    endAt: z.string().min(1),
    reason: z.string().max(200).optional(),
    professionalId: z.string().optional(),
  })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), {
    message: 'endAt > startAt',
    path: ['endAt'],
  });

type ToffFormValues = z.infer<typeof toffSchema>;

type PanelMode =
  | { kind: 'empty' }
  | { kind: 'create' }
  | { kind: 'edit'; row: TimeOff };

/* ─────────────────────────── Helpers ─────────────────────────── */

/** ISO `YYYY-MM-DDTHH:mm` compatible con `<input type="datetime-local">`. */
function toLocalDatetimeString(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

/* ═══════════════════════════════════════════════════════════════════
 *                          TIME OFF CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Master-detail 2-col (mismo patrón que servicios/profesionales). Rows ordenadas
 * por fecha próxima: los eventos futuros arriba (agrupables por "activo/próximo"
 * vs "pasado"). El detail panel es el form inline con date-time pickers.
 */
export function TimeOffClient({
  locale,
  rows: initialRows,
  professionals,
}: Props) {
  const t = useTranslations('panel.timeOff');
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const [deleteTarget, setDeleteTarget] = useState<TimeOff | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const { data: rows = initialRows } = useQuery({
    queryKey: queryKeys.timeOff(),
    queryFn: () => apiQuery<TimeOff[]>('/api/time-off'),
    initialData: initialRows,
    staleTime: 30_000,
  });

  function fmt(iso: string): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false,
    }).format(new Date(iso));
  }

  function fmtDay(iso: string): string {
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  }

  function fmtTime(iso: string): string {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  }

  function profName(id: string | null): string {
    if (!id) return t('allProfessionals');
    return professionals.find((p) => p.id === id)?.name ?? id;
  }

  // Búsqueda cliente-side: match en reason, nombre del profesional o fecha
  // formateada (permite buscar "15 mar" o "vacaciones" o "Ríos").
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.reason ?? '').toLowerCase().includes(q) ||
        profName(r.professionalId).toLowerCase().includes(q) ||
        fmtDay(r.startAt).toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, locale, professionals, t]);

  // Ordenamos: próximos primero (asc), pasados al final. Los pasados quedan
  // con un separador visual para no confundir "esto viene" con "esto ya fue".
  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const up: TimeOff[] = [];
    const pa: TimeOff[] = [];
    for (const r of filtered) {
      if (new Date(r.endAt).getTime() >= now) up.push(r);
      else pa.push(r);
    }
    up.sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
    );
    pa.sort(
      (a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime(),
    );
    return { upcoming: up, past: pa };
  }, [filtered]);

  const activeId = panel.kind === 'edit' ? panel.row.id : null;

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/time-off/${id}`, 'DELETE'),
    onSuccess: (_data, deletedId) => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: ['timeOff'] });
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

  function openEdit(r: TimeOff) {
    setPanel({ kind: 'edit', row: r });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    setMobileSheetOpen(false);
  }

  function handleFormSuccess(saved: TimeOff, wasCreate: boolean) {
    setPanel({ kind: 'edit', row: saved });
    if (wasCreate) setMobileSheetOpen(false);
  }

  const panelContent =
    panel.kind === 'empty' ? (
      <EmptyPanel onCreate={openCreate} />
    ) : (
      <TimeOffForm
        key={panel.kind === 'edit' ? panel.row.id : 'new'}
        mode={panel}
        professionals={professionals}
        onClose={closePanel}
        onSuccess={handleFormSuccess}
        onDelete={(r) => setDeleteTarget(r)}
      />
    );

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* ─────────  IZQUIERDA — LISTA  ───────── */}
        <aside className="flex min-h-0 w-full flex-col border-r border-border/60 md:w-[380px] md:shrink-0">
          <div className="shrink-0 space-y-2 border-b border-border/60 p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
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
              {t('countLabel', { n: rows.length })}
              {search && filtered.length !== rows.length ? (
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

          {filtered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">
                  {search ? t('noSearchResults') : t('emptyList')}
                </p>
                {!search ? (
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
              {upcoming.length > 0 ? (
                <section>
                  <h3 className="sticky top-0 z-10 border-b border-border/40 bg-card/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                    {t('groups.upcoming')}
                  </h3>
                  <ul className="space-y-0.5 p-1">
                    {upcoming.map((r) => (
                      <li key={r.id}>
                        <TimeOffRow
                          row={r}
                          active={r.id === activeId}
                          onSelect={() => openEdit(r)}
                          fmtDay={fmtDay}
                          fmtTime={fmtTime}
                          profName={profName}
                          t={t}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {past.length > 0 ? (
                <section>
                  <h3 className="sticky top-0 z-10 border-b border-t border-border/40 bg-card/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                    {t('groups.past')}
                  </h3>
                  <ul className="space-y-0.5 p-1 opacity-70">
                    {past.map((r) => (
                      <li key={r.id}>
                        <TimeOffRow
                          row={r}
                          active={r.id === activeId}
                          onSelect={() => openEdit(r)}
                          fmtDay={fmtDay}
                          fmtTime={fmtTime}
                          profName={profName}
                          t={t}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
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
                {fmt(deleteTarget.startAt)} → {fmt(deleteTarget.endAt)}
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
 *                            TIME OFF ROW
 * ═══════════════════════════════════════════════════════════════════ */

function TimeOffRow({
  row: r,
  active,
  onSelect,
  fmtDay,
  fmtTime,
  profName,
  t,
}: {
  row: TimeOff;
  active: boolean;
  onSelect: () => void;
  fmtDay: (iso: string) => string;
  fmtTime: (iso: string) => string;
  profName: (id: string | null) => string;
  t: ReturnType<typeof useTranslations<'panel.timeOff'>>;
}) {
  const sameDay =
    new Date(r.startAt).toDateString() === new Date(r.endAt).toDateString();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand-50 text-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-2.5 h-10 w-0.5 rounded-r-full bg-brand-600"
        />
      ) : null}
      <div className="mt-0.5 flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-md border border-border bg-muted/40 text-center">
        <span className="text-[9px] font-medium uppercase text-muted-foreground">
          {new Intl.DateTimeFormat(undefined, { month: 'short' }).format(
            new Date(r.startAt),
          )}
        </span>
        <span className="text-xs font-semibold tabular-nums leading-none text-foreground">
          {new Date(r.startAt).getDate()}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {r.reason?.trim() || t('untitled')}
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] tabular-nums text-muted-foreground">
          {sameDay ? (
            <>
              {fmtTime(r.startAt)} → {fmtTime(r.endAt)}
            </>
          ) : (
            <>
              {fmtDay(r.startAt)} → {fmtDay(r.endAt)}
            </>
          )}
        </p>
        <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
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
  const t = useTranslations('panel.timeOff');
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
          {/* Calendario estilizado */}
          <rect
            x="38"
            y="42"
            width="44"
            height="38"
            rx="4"
            stroke="currentColor"
            strokeWidth="1.5"
            className="opacity-60"
          />
          <line
            x1="38"
            y1="52"
            x2="82"
            y2="52"
            stroke="currentColor"
            strokeWidth="1.5"
            className="opacity-60"
          />
          <line
            x1="48"
            y1="38"
            x2="48"
            y2="46"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="opacity-60"
          />
          <line
            x1="72"
            y1="38"
            x2="72"
            y2="46"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="opacity-60"
          />
          {/* X gruesa cruzando el calendario — "día bloqueado" */}
          <line
            x1="50"
            y1="60"
            x2="70"
            y2="76"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="text-amber-500/80"
          />
          <line
            x1="70"
            y1="60"
            x2="50"
            y2="76"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="text-amber-500/80"
          />
          {/* Sparkle */}
          <path
            d="M28 34l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
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
 *                            TIME OFF FORM
 * ═══════════════════════════════════════════════════════════════════ */

function TimeOffForm({
  mode,
  professionals,
  onClose,
  onSuccess,
  onDelete,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; row: TimeOff };
  professionals: ProfessionalLite[];
  onClose: () => void;
  onSuccess: (saved: TimeOff, wasCreate: boolean) => void;
  onDelete: (r: TimeOff) => void;
}) {
  const t = useTranslations('panel.timeOff');
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
  } = useForm<ToffFormValues>({
    resolver: zodResolver(toffSchema),
    defaultValues: {
      startAt: row ? toLocalDatetimeString(row.startAt) : '',
      endAt: row ? toLocalDatetimeString(row.endAt) : '',
      reason: row?.reason ?? '',
      professionalId: row?.professionalId ?? '',
    },
  });

  useEffect(() => {
    reset({
      startAt: row ? toLocalDatetimeString(row.startAt) : '',
      endAt: row ? toLocalDatetimeString(row.endAt) : '',
      reason: row?.reason ?? '',
      professionalId: row?.professionalId ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const professionalId = watch('professionalId');

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!isEdit) {
        return apiMutation<TimeOff, Record<string, unknown>>(
          '/api/time-off',
          'POST',
          payload,
        );
      }
      return apiMutation<TimeOff, Record<string, unknown>>(
        `/api/time-off/${row!.id}`,
        'PATCH',
        payload,
      );
    },
    onSuccess: (saved) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['timeOff'] });
      onSuccess(saved, !isEdit);
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ToffFormValues) {
    const payload = {
      startAt: localToISO(values.startAt),
      endAt: localToISO(values.endAt),
      ...(values.reason?.trim() ? { reason: values.reason.trim() } : {}),
      ...(values.professionalId
        ? { professionalId: values.professionalId }
        : {}),
    };
    await saveMutation.mutateAsync(payload).catch(() => undefined);
  }

  const busy = saveMutation.isPending;

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
            {isEdit ? row!.reason?.trim() || t('untitled') : t('newSubtitle')}
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="toff-start">{t('fields.start')}</Label>
            <Input
              id="toff-start"
              type="datetime-local"
              {...register('startAt')}
              disabled={busy}
            />
            {errors.startAt ? (
              <p className="text-xs text-destructive">
                {t('errors.required')}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="toff-end">{t('fields.end')}</Label>
            <Input
              id="toff-end"
              type="datetime-local"
              {...register('endAt')}
              disabled={busy}
            />
            {errors.endAt ? (
              <p className="text-xs text-destructive">
                {t('errors.rangeInvalid')}
              </p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="toff-reason" className="flex items-center gap-1.5">
            <FileText
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {t('fields.reason')}{' '}
            <span className="text-xs text-muted-foreground">
              ({t('optional')})
            </span>
          </Label>
          <Input
            id="toff-reason"
            maxLength={200}
            placeholder={t('placeholders.reason')}
            {...register('reason')}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="toff-prof" className="flex items-center gap-1.5">
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
            <SelectTrigger id="toff-prof">
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
