'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Briefcase,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  LayoutGrid,
  Plus,
  Rows3,
  Search,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, type AppointmentStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { APPOINTMENT_STATUS_TOKENS } from '@/components/ui/tokens';
import { ApiError, apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { AppointmentDialog } from './AppointmentDialog';

type ViewMode = 'month' | 'week' | 'day';

interface Appointment {
  id: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  patient: { id: string; name: string; phone: string };
  service: { id: string; name: string; durationMin: number };
  professional: { id: string; name: string };
}

interface Professional {
  id: string;
  name: string;
  active?: boolean;
  serviceIds?: string[];
}

interface ServiceLite {
  id: string;
  name: string;
  durationMin: number;
  active: boolean;
}

interface AgendaClientProps {
  locale: string;
  date: string;
  view: ViewMode;
  professionalId: string;
  status: string; // CSV de statuses
  query: string;
  appointments: Appointment[];
  professionals: Professional[];
  services: ServiceLite[];
  timezone: string;
}

/**
 * FSM válida — coincide con `assertTransition` del backend. Si el backend
 * agrega/quita transiciones, sincronizar acá.
 */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDIENTE: ['CONFIRMADA', 'CANCELADA'],
  CONFIRMADA: ['ATENDIDA', 'CANCELADA', 'NO_SHOW'],
  EN_RIESGO: ['CONFIRMADA', 'CANCELADA', 'NO_SHOW', 'ATENDIDA'],
  ATENDIDA: [],
  CANCELADA: [],
  NO_SHOW: [],
};

const ALL_STATUSES: AppointmentStatus[] = [
  'PENDIENTE',
  'CONFIRMADA',
  'EN_RIESGO',
  'ATENDIDA',
  'CANCELADA',
  'NO_SHOW',
];

function transitionButtonVariant(
  next: AppointmentStatus,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (next === 'CANCELADA' || next === 'NO_SHOW') return 'destructive';
  if (next === 'ATENDIDA') return 'secondary';
  return 'default';
}

export function AgendaClient({
  locale,
  date,
  view,
  professionalId,
  status,
  query,
  appointments: initialAppointments,
  professionals,
  services,
  timezone,
}: AgendaClientProps) {
  const t = useTranslations('panel.agenda');
  const tStatus = useTranslations('panel.dashboard.status');
  const router = useRouter();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<Appointment | null>(null);
  // Estado local del search — mientras el user tipea, filtramos client-side
  // sin actualizar la URL. La URL se sincroniza on blur/enter (patrón similar
  // al listado de conversaciones).
  const [searchDraft, setSearchDraft] = useState(query);
  // Dialogs de agendar/reagendar/cancelar. Solo uno abierto a la vez.
  const [createOpen, setCreateOpen] = useState(false);
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(
    null,
  );
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);

  const statusSet = useMemo(
    () =>
      new Set(
        (status || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean) as AppointmentStatus[],
      ),
    [status],
  );

  const appointmentsKey = queryKeys.appointments({
    date,
    view,
    professionalId,
    // Cache-key: incluimos el CSV crudo para que cada combinación de filtros
    // sea una entrada de cache independiente (con su propio initialData del SSR).
    status,
  });

  const { data: rawAppointments = initialAppointments } = useQuery({
    queryKey: appointmentsKey,
    queryFn: () => {
      const { from, to } = rangeForClient(date, view);
      const qs = new URLSearchParams();
      qs.set('from', from.toISOString());
      qs.set('to', to.toISOString());
      qs.set('limit', '200');
      if (professionalId) qs.set('professionalId', professionalId);
      // Backend acepta un solo status. Multi-status → filtramos client-side.
      if (statusSet.size === 1) qs.set('status', [...statusSet][0]!);
      return apiQuery<Appointment[]>(`/api/appointments?${qs.toString()}`);
    },
    initialData: initialAppointments,
  });

  // Aplicamos multi-status + búsqueda por paciente en cliente. `search` es
  // el estado local del input; buscamos por nombre y por teléfono (dígitos).
  const appointments = useMemo(() => {
    const needle = searchDraft.trim().toLowerCase();
    return rawAppointments.filter((a) => {
      if (statusSet.size >= 2 && !statusSet.has(a.status)) return false;
      if (!needle) return true;
      return (
        a.patient.name.toLowerCase().includes(needle) ||
        a.patient.phone.toLowerCase().includes(needle)
      );
    });
  }, [rawAppointments, statusSet, searchDraft]);

  function updateQuery(patch: Record<string, string | undefined>) {
    const qs = new URLSearchParams();
    const merged = {
      date,
      view,
      professionalId: professionalId || undefined,
      status: status || undefined,
      q: query || undefined,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) qs.set(k, v);
    }
    router.push(`?${qs.toString()}`);
  }

  const changeStatusMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: AppointmentStatus }) =>
      apiMutation<Appointment, { status: AppointmentStatus }>(
        `/api/appointments/${id}/status`,
        'PATCH',
        { status: next },
      ),
    onMutate: async ({ id, next }) => {
      await qc.cancelQueries({ queryKey: appointmentsKey });
      const snapshot = qc.getQueryData<Appointment[]>(appointmentsKey);
      qc.setQueryData<Appointment[]>(appointmentsKey, (old) =>
        (old ?? []).map((a) => (a.id === id ? { ...a, status: next } : a)),
      );
      return { snapshot };
    },
    onSuccess: () => {
      toast.success(t('statusChanged'));
      setSelected(null);
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshot) {
        qc.setQueryData(appointmentsKey, ctx.snapshot);
      }
      if (err instanceof ApiError && err.status === 422) {
        toast.info(t('statusRaceRefresh'));
        setSelected(null);
        void qc.invalidateQueries({ queryKey: appointmentsKey });
        return;
      }
      toast.error(t('statusChangeFailed'));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: appointmentsKey });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboardMetrics });
    },
  });

  function changeStatus(next: AppointmentStatus) {
    if (!selected) return;
    changeStatusMutation.mutate({ id: selected.id, next });
  }

  const busy = changeStatusMutation.isPending;

  const shiftPeriod = (dir: -1 | 1) => {
    if (view === 'month') updateQuery({ date: shiftMonthISO(date, dir) });
    else if (view === 'week') updateQuery({ date: shiftDayISO(date, dir * 7) });
    else updateQuery({ date: shiftDayISO(date, dir) });
  };

  const goToday = () => {
    updateQuery({ date: normalizeDateForView(todayISO(), view) });
  };

  const toggleStatus = (s: AppointmentStatus) => {
    const next = new Set(statusSet);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    updateQuery({ status: next.size ? [...next].join(',') : undefined });
  };

  const clearAllFilters = () => {
    setSearchDraft('');
    updateQuery({
      professionalId: undefined,
      status: undefined,
      q: undefined,
    });
  };

  const applyPresetPending = () => {
    updateQuery({ status: 'PENDIENTE,EN_RIESGO' });
  };

  const hasActiveFilters =
    Boolean(professionalId) || statusSet.size > 0 || Boolean(searchDraft);

  const periodLabel = useMemo(
    () => formatPeriodLabel(date, view, locale),
    [date, view, locale],
  );

  return (
    <>
      {/* ──────────────────────────  TOOLBAR  ────────────────────────── */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        {/* Fila principal — título del período + navegación + tabs de vista */}
        <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => shiftPeriod(-1)}
                aria-label={t('prevPeriod')}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => shiftPeriod(1)}
                aria-label={t('nextPeriod')}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={goToday}
            >
              {t('today')}
            </Button>
            <div className="ml-2 flex flex-col leading-tight">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                {periodLabel.title}
              </h2>
              {periodLabel.sub ? (
                <span className="text-xs text-muted-foreground">
                  {periodLabel.sub}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Tabs
              value={view}
              onValueChange={(v) => {
                const next = v as ViewMode;
                updateQuery({
                  view: next,
                  date: normalizeDateForView(date, next),
                });
              }}
            >
              <TabsList className="h-9">
                <TabsTrigger value="month" className="gap-1.5 px-3">
                  <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('viewMonth')}
                </TabsTrigger>
                <TabsTrigger value="week" className="gap-1.5 px-3">
                  <Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('viewWeek')}
                </TabsTrigger>
                <TabsTrigger value="day" className="gap-1.5 px-3">
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('viewDay')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('newAppointment')}
            </Button>
          </div>
        </div>

        {/* Filtros: TODO en una sola fila.
            Orden: [dropdown Estados] [search flexible] [prof select] [clear].
            El dropdown de estados es multi-select (checkboxes) + acciones rápidas
            (todos, ninguno, preset pendientes). En pantallas muy chicas los
            controles pueden envolver pero cada control mantiene su ancho fijo. */}
        <div className="flex flex-wrap items-center gap-2 p-4">
          <StatusFilterDropdown
            statusSet={statusSet}
            onToggle={toggleStatus}
            onClear={() => updateQuery({ status: undefined })}
            onPresetPending={applyPresetPending}
            onSelectAll={() =>
              updateQuery({ status: ALL_STATUSES.join(',') })
            }
          />

          <div className="relative min-w-0 flex-1 sm:max-w-[320px]">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onBlur={() =>
                updateQuery({ q: searchDraft.trim() || undefined })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={t('filters.searchPlaceholder')}
              className="h-9 w-full pl-8"
              aria-label={t('filters.search')}
            />
          </div>

          <div className="w-44 shrink-0 sm:w-56">
            <label htmlFor="agenda-professional" className="sr-only">
              {t('filters.allProfessionals')}
            </label>
            <Select
              value={professionalId || '__all'}
              onValueChange={(v) =>
                updateQuery({
                  professionalId: v === '__all' ? undefined : v,
                })
              }
            >
              <SelectTrigger id="agenda-professional" className="h-9 text-sm">
                <SelectValue placeholder={t('filters.allProfessionals')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">
                  {t('filters.allProfessionals')}
                </SelectItem>
                {professionals.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasActiveFilters ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              className="h-9 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{t('filters.clearAll')}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* ──────────────────────────  VISTAS  ────────────────────────── */}
      <div className="mt-4">
        {view === 'month' ? (
          <MonthView
            date={date}
            appointments={appointments}
            locale={locale}
            onPickDay={(d) => updateQuery({ view: 'day', date: d })}
            onSelect={setSelected}
          />
        ) : view === 'week' ? (
          <WeekView
            date={date}
            appointments={appointments}
            locale={locale}
            onSelect={setSelected}
            onPickDay={(d) => updateQuery({ view: 'day', date: d })}
          />
        ) : (
          <DayView
            date={date}
            appointments={appointments}
            locale={locale}
            onSelect={setSelected}
            emptyTitle={t('emptyState.title')}
            emptyDescription={t('emptyState.description')}
          />
        )}
      </div>

      {/* ──────────────────────────  DETALLE  ────────────────────────── */}
      <Dialog
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('detailTitle')}</DialogTitle>
          </DialogHeader>
          {selected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold text-foreground">
                    {selected.patient.name}
                  </p>
                  <p className="truncate text-sm tabular-nums text-muted-foreground">
                    {selected.patient.phone}
                  </p>
                </div>
                <Badge variant={selected.status} className="shrink-0">
                  {tStatus(selected.status)}
                </Badge>
              </div>

              <dl className="space-y-2 text-sm">
                <div className="flex items-center gap-3">
                  <Clock
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <dt className="sr-only">{t('detail.time')}</dt>
                    <dd className="tabular-nums text-foreground">
                      {formatDateTime(selected.startAt, locale)}
                    </dd>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Briefcase
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <dt className="sr-only">{t('detail.service')}</dt>
                    <dd className="text-foreground">
                      {selected.service.name}{' '}
                      <span className="tabular-nums text-muted-foreground">
                        · {selected.service.durationMin} min
                      </span>
                    </dd>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <User
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <dt className="sr-only">{t('detail.professional')}</dt>
                    <dd className="text-foreground">
                      {selected.professional.name}
                    </dd>
                  </div>
                </div>
              </dl>

              <div className="border-t border-border pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('detail.transitions')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {/* "Reagendar" es una acción ortogonal al FSM de status —
                      solo tiene sentido cuando la cita sigue viva (mismos
                      estados que RESCHEDULABLE_STATUSES del backend). */}
                  {RESCHEDULABLE_STATUSES.includes(selected.status) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const target = selected;
                        setSelected(null);
                        setRescheduleTarget(target);
                      }}
                    >
                      {t('detail.reschedule')}
                    </Button>
                  ) : null}
                  {TRANSITIONS[selected.status].length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('detail.noTransitions')}
                    </p>
                  ) : (
                    TRANSITIONS[selected.status].map((next) => {
                      // Cancelación/no-show → pedir confirmación (evita clic
                      // accidental irreversible). El resto va directo.
                      const needsConfirm =
                        next === 'CANCELADA' || next === 'NO_SHOW';
                      return (
                        <Button
                          key={next}
                          size="sm"
                          variant={transitionButtonVariant(next)}
                          disabled={busy}
                          onClick={() => {
                            if (needsConfirm) {
                              // Cerramos el detalle y abrimos el confirm por
                              // separado — evitamos dialog dentro de dialog.
                              const target = selected;
                              setSelected(null);
                              setCancelTarget({
                                ...target,
                                status: next, // memorizamos el status objetivo
                              } as Appointment);
                            } else {
                              changeStatus(next);
                            }
                          }}
                        >
                          {tStatus(next)}
                        </Button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ─────────────────  DIALOG: Nueva cita  ───────────────── */}
      {createOpen ? (
        <AppointmentDialog
          mode="create"
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: appointmentsKey });
            void qc.invalidateQueries({ queryKey: queryKeys.dashboardMetrics });
          }}
          locale={locale}
          timezone={timezone}
          services={services}
          professionals={professionals.map((p) => ({
            id: p.id,
            name: p.name,
            active: p.active ?? true,
            serviceIds: p.serviceIds ?? [],
          }))}
          initialDate={date}
        />
      ) : null}

      {/* ─────────────────  DIALOG: Reagendar  ───────────────── */}
      {rescheduleTarget ? (
        <AppointmentDialog
          mode="reschedule"
          open={rescheduleTarget !== null}
          onClose={() => setRescheduleTarget(null)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: appointmentsKey });
          }}
          locale={locale}
          timezone={timezone}
          appointment={{
            id: rescheduleTarget.id,
            startAt: rescheduleTarget.startAt,
            patient: rescheduleTarget.patient,
            service: rescheduleTarget.service,
            professional: rescheduleTarget.professional,
          }}
        />
      ) : null}

      {/* ─────────────────  CONFIRM: Cancelar / No-show  ───────────────── */}
      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={async () => {
          if (!cancelTarget) return;
          await new Promise<void>((resolve, reject) => {
            changeStatusMutation.mutate(
              { id: cancelTarget.id, next: cancelTarget.status },
              {
                onSuccess: () => {
                  setCancelTarget(null);
                  resolve();
                },
                onError: (err) => {
                  // El onError global ya muestra toast — solo resolvemos para
                  // que el ConfirmDialog cierre su spinner.
                  reject(err);
                },
              },
            );
          }).catch(() => undefined);
        }}
        title={
          cancelTarget?.status === 'NO_SHOW'
            ? t('confirmNoShow.title')
            : t('confirmCancel.title')
        }
        description={
          cancelTarget?.status === 'NO_SHOW'
            ? t('confirmNoShow.description', {
                name: cancelTarget?.patient.name ?? '',
              })
            : t('confirmCancel.description', {
                name: cancelTarget?.patient.name ?? '',
              })
        }
        confirmLabel={
          cancelTarget?.status === 'NO_SHOW'
            ? t('confirmNoShow.confirm')
            : t('confirmCancel.confirm')
        }
        variant="destructive"
      />
    </>
  );
}

/**
 * Estados vivos que aceptan reagendamiento. Debe estar sincronizado con
 * `RESCHEDULABLE_STATUSES` del backend (appointment-status.util.ts).
 */
const RESCHEDULABLE_STATUSES: AppointmentStatus[] = [
  'PENDIENTE',
  'CONFIRMADA',
  'EN_RIESGO',
];

/* ═══════════════════════════════════════════════════════════════════
 *                        STATUS FILTER DROPDOWN
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Dropdown multi-select para filtrar por estado. Reemplaza a la fila de
 * chips previa — mantiene semántica de multi-select (checkboxes) y suma
 * acciones rápidas (todos / limpiar / preset).
 *
 * IMPORTANTE: usamos `onSelect={(e) => e.preventDefault()}` en cada
 * CheckboxItem para que Radix NO cierre el menú al toggelear — la
 * intención UX en un multi-select es que el usuario marque varios estados
 * en una sola apertura y cierre cuando quiera.
 */
function StatusFilterDropdown({
  statusSet,
  onToggle,
  onClear,
  onPresetPending,
  onSelectAll,
}: {
  statusSet: Set<AppointmentStatus>;
  onToggle: (s: AppointmentStatus) => void;
  onClear: () => void;
  onPresetPending: () => void;
  onSelectAll: () => void;
}) {
  const t = useTranslations('panel.agenda');
  const tStatus = useTranslations('panel.dashboard.status');
  const count = statusSet.size;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-2"
        >
          <Filter className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('filters.status')}</span>
          {count > 0 ? (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold tabular-nums text-white">
              {count}
            </span>
          ) : null}
          <ChevronDown
            className="h-3.5 w-3.5 opacity-60"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{t('filters.status')}</span>
          {count > 0 ? (
            <button
              type="button"
              onClick={onClear}
              className="text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              {t('filters.clearAll')}
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_STATUSES.map((s) => {
          const checked = statusSet.has(s);
          return (
            <DropdownMenuCheckboxItem
              key={s}
              checked={checked}
              onCheckedChange={() => onToggle(s)}
              onSelect={(e) => e.preventDefault()}
              className="gap-2"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  APPOINTMENT_STATUS_TOKENS[s].dot,
                )}
                aria-hidden="true"
              />
              {tStatus(s)}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSelectAll}>
          {t('filters.selectAll')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onPresetPending}
          className="text-brand-700 focus:text-brand-700"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          {t('filters.presets.pending')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                             MONTH VIEW
 * ═══════════════════════════════════════════════════════════════════ */

function MonthView({
  date,
  appointments,
  locale,
  onPickDay,
  onSelect,
}: {
  date: string;
  appointments: Appointment[];
  locale: string;
  onPickDay: (dateISO: string) => void;
  onSelect: (a: Appointment) => void;
}) {
  const t = useTranslations('panel.agenda');
  const tStatus = useTranslations('panel.dashboard.status');

  // Grid 7x6 — 42 celdas comenzando en el lunes previo al día 1 del mes.
  const gridStart = useMemo(() => firstMondayOfMonthGrid(date), [date]);
  const currentMonth = useMemo(() => date.slice(0, 7), [date]);
  const todayStr = useMemo(() => todayISO(), []);

  const days = useMemo(
    () => Array.from({ length: 42 }, (_, i) => shiftDayISO(gridStart, i)),
    [gridStart],
  );

  const weekdays = useMemo(() => weekdayNames(locale), [locale]);

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const d of days) map.set(d, []);
    for (const a of appointments) {
      const key = a.startAt.slice(0, 10);
      const bucket = map.get(key);
      if (bucket) bucket.push(a);
    }
    // ordenar por hora dentro de cada día
    for (const bucket of map.values()) {
      bucket.sort((a, b) => a.startAt.localeCompare(b.startAt));
    }
    return map;
  }, [appointments, days]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Cabecera con días de la semana */}
      <div className="grid grid-cols-7 border-b border-border bg-muted/40">
        {weekdays.map((w) => (
          <div
            key={w}
            className="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {w}
          </div>
        ))}
      </div>

      {/* Grid de 6 semanas */}
      <div className="grid grid-cols-7 grid-rows-6 divide-x divide-y divide-border border-t border-border">
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          const isCurrentMonth = d.slice(0, 7) === currentMonth;
          const isToday = d === todayStr;
          const [, , dayNum] = d.split('-');
          const visible = items.slice(0, 3);
          const overflow = items.length - visible.length;

          return (
            <button
              key={d}
              type="button"
              onClick={() => onPickDay(d)}
              className={cn(
                'group relative flex min-h-[112px] flex-col gap-1.5 p-2 text-left transition-colors',
                'focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                isCurrentMonth
                  ? 'bg-card hover:bg-accent/40'
                  : 'bg-muted/20 text-muted-foreground/70 hover:bg-muted/40',
              )}
              aria-label={`${d} · ${items.length} citas`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    'inline-flex h-6 min-w-[24px] items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
                    isToday
                      ? 'bg-brand-600 text-white shadow-sm'
                      : isCurrentMonth
                        ? 'text-foreground'
                        : 'text-muted-foreground/70',
                  )}
                >
                  {Number(dayNum)}
                </span>
                {items.length > 0 ? (
                  <span className="text-[10px] font-medium tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    {items.length}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-1 flex-col gap-1">
                {visible.map((a) => (
                  <span
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(a);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelect(a);
                      }
                    }}
                    className={cn(
                      'flex items-center gap-1.5 truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-transform hover:-translate-y-px hover:shadow-sm',
                      APPOINTMENT_STATUS_TOKENS[a.status].subtle,
                    )}
                    title={`${formatTime(a.startAt, locale)} · ${a.patient.name} · ${tStatus(a.status)}`}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        APPOINTMENT_STATUS_TOKENS[a.status].dot,
                      )}
                      aria-hidden="true"
                    />
                    <span className="shrink-0 tabular-nums opacity-90">
                      {formatTime(a.startAt, locale)}
                    </span>
                    <span className="truncate">{a.patient.name}</span>
                  </span>
                ))}
                {overflow > 0 ? (
                  <span className="pl-1 text-[10px] font-medium text-muted-foreground">
                    {t('monthOverflow', { count: overflow })}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                             WEEK VIEW
 * ═══════════════════════════════════════════════════════════════════ */

function WeekView({
  date,
  appointments,
  locale,
  onSelect,
  onPickDay,
}: {
  date: string;
  appointments: Appointment[];
  locale: string;
  onSelect: (a: Appointment) => void;
  onPickDay: (dateISO: string) => void;
}) {
  const tStatus = useTranslations('panel.dashboard.status');
  const t = useTranslations('panel.agenda');

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => shiftDayISO(date, i));
  }, [date]);

  const todayStr = useMemo(() => todayISO(), []);

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const d of days) map.set(d, []);
    for (const a of appointments) {
      const key = a.startAt.slice(0, 10);
      const bucket = map.get(key);
      if (bucket) bucket.push(a);
    }
    for (const b of map.values()) {
      b.sort((a, b) => a.startAt.localeCompare(b.startAt));
    }
    return map;
  }, [appointments, days]);

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
      <div className="grid min-w-[980px] grid-cols-7 divide-x divide-border">
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          const isToday = d === todayStr;
          const [, , dayNum] = d.split('-');

          return (
            <div key={d} className="flex min-h-[360px] flex-col">
              <button
                type="button"
                onClick={() => onPickDay(d)}
                className={cn(
                  'flex items-center gap-2 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40',
                  isToday ? 'bg-brand-50/50' : 'bg-muted/30',
                )}
              >
                <span
                  className={cn(
                    'text-[10px] font-semibold uppercase tracking-wider',
                    isToday ? 'text-brand-700' : 'text-muted-foreground',
                  )}
                >
                  {formatWeekdayOnly(d, locale)}
                </span>
                <span
                  className={cn(
                    'inline-flex h-6 min-w-[24px] items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                    isToday
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'text-foreground',
                  )}
                >
                  {Number(dayNum)}
                </span>
              </button>
              <div className="flex-1 space-y-1 p-1.5">
                {items.length === 0 ? (
                  <p
                    className="px-1 pt-1 text-xs text-muted-foreground/60"
                    aria-label={t('emptyDay')}
                  >
                    —
                  </p>
                ) : (
                  items.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onSelect(a)}
                      className={cn(
                        'block w-full rounded-md border px-2 py-1.5 text-left text-xs shadow-sm transition-all hover:-translate-y-px hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        APPOINTMENT_STATUS_TOKENS[a.status].subtle,
                      )}
                    >
                      <p className="flex items-center gap-1 tabular-nums font-medium">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        {formatTime(a.startAt, locale)}
                      </p>
                      <p className="mt-0.5 truncate font-medium">
                        {a.patient.name}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] opacity-80">
                        {a.service.name}
                      </p>
                      <p className="truncate text-[10px] opacity-75">
                        {tStatus(a.status)}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                             DAY VIEW
 * ═══════════════════════════════════════════════════════════════════ */

function DayView({
  date,
  appointments,
  locale,
  onSelect,
  emptyTitle,
  emptyDescription,
}: {
  date: string;
  appointments: Appointment[];
  locale: string;
  onSelect: (a: Appointment) => void;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const tStatus = useTranslations('panel.dashboard.status');
  const t = useTranslations('panel.agenda');

  const stats = useMemo(() => {
    const acc: Partial<Record<AppointmentStatus, number>> = {};
    for (const a of appointments) {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
    }
    return acc;
  }, [appointments]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      {/* Timeline */}
      <div>
        {appointments.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card p-12 text-center">
            <div className="rounded-full bg-muted p-3">
              <CalendarOff
                className="h-6 w-6 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">
              {emptyTitle}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {emptyDescription}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card shadow-sm">
            {appointments.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onSelect(a)}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-accent/50 focus:outline-none focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <div className="flex w-16 flex-col items-start">
                    <span className="text-base font-semibold tabular-nums text-foreground">
                      {formatTime(a.startAt, locale)}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {a.service.durationMin}′
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {a.patient.name}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <Briefcase
                        className="h-3 w-3 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">{a.service.name}</span>
                      <span aria-hidden="true">·</span>
                      <User className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{a.professional.name}</span>
                    </p>
                  </div>
                  <Badge variant={a.status} className="shrink-0">
                    {tStatus(a.status)}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Panel de resumen — sólo desktop */}
      <aside className="hidden space-y-4 lg:block">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 border-b border-border pb-3">
            <CalendarDays
              className="h-4 w-4 text-brand-600"
              aria-hidden="true"
            />
            <h3 className="text-sm font-semibold text-foreground">
              {t('summary.title')}
            </h3>
          </div>
          <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
            {formatLongDate(date, locale)}
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
            {appointments.length}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('summary.appointments')}
          </p>

          <Separator className="my-4" />

          <ul className="space-y-2">
            {ALL_STATUSES.map((s) => {
              const n = stats[s] ?? 0;
              if (n === 0) return null;
              return (
                <li
                  key={s}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        APPOINTMENT_STATUS_TOKENS[s].dot,
                      )}
                      aria-hidden="true"
                    />
                    {tStatus(s)}
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {n}
                  </span>
                </li>
              );
            })}
            {appointments.length === 0 ? (
              <li className="text-xs text-muted-foreground">
                {t('summary.emptyStats')}
              </li>
            ) : null}
          </ul>
        </div>

        {(stats.EN_RIESGO ?? 0) + (stats.PENDIENTE ?? 0) > 0 ? (
          <div className="flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50/60 p-3 text-xs text-orange-900">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              {t('summary.pendingHint', {
                count: (stats.EN_RIESGO ?? 0) + (stats.PENDIENTE ?? 0),
              })}
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                          HELPERS
 * ═══════════════════════════════════════════════════════════════════ */

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Formatea el label de período visible en el header del toolbar.
 * - month → "Agosto 2026"
 * - week  → "5 – 11 Agosto 2026" (con sub = "Semana N")
 * - day   → "Sábado 9 de agosto" (sub = "2026")
 */
function formatPeriodLabel(
  dateISO: string,
  view: ViewMode,
  locale: string,
): { title: string; sub?: string } {
  const [y, m, d] = dateISO.split('-').map(Number);
  const anchor = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));

  if (view === 'month') {
    const title = new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(anchor);
    return { title: capitalize(title) };
  }

  if (view === 'week') {
    const end = new Date(anchor);
    end.setUTCDate(end.getUTCDate() + 6);
    const sameMonth = anchor.getUTCMonth() === end.getUTCMonth();
    const yearFmt = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      timeZone: 'UTC',
    }).format(anchor);
    if (sameMonth) {
      const monthYear = new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(anchor);
      const startDay = anchor.getUTCDate();
      const endDay = end.getUTCDate();
      return { title: `${startDay} – ${endDay} ${capitalize(monthYear)}` };
    }
    const startFmt = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(anchor);
    const endFmt = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(end);
    return { title: `${startFmt} – ${endFmt}`, sub: yearFmt };
  }

  const long = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(anchor);
  const yearFmt = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    timeZone: 'UTC',
  }).format(anchor);
  return { title: capitalize(long), sub: yearFmt };
}

function formatWeekdayOnly(dateStr: string, locale: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  })
    .format(new Date(ms))
    .replace('.', '');
}

function formatLongDate(dateStr: string, locale: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

/**
 * Nombres de los días de la semana empezando en LUNES.
 * Usamos un lunes conocido (2024-01-01 fue lunes) como ancla UTC.
 */
function weekdayNames(locale: string): string[] {
  const monday = Date.UTC(2024, 0, 1); // 2024-01-01 = lunes
  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(monday + i * 86_400_000)).replace('.', ''),
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Suma `delta` días a `YYYY-MM-DD` (ancla UTC — no depende de TZ local).
 */
function shiftDayISO(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Suma `delta` meses a `YYYY-MM-DD` preservando el día (o cae al último día
 * válido si el mes destino es más corto — comportamiento nativo de setUTCMonth).
 */
function shiftMonthISO(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const target = new Date(Date.UTC(y!, (m ?? 1) - 1 + delta, 1));
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const day = Math.min(d ?? 1, daysInTarget);
  target.setUTCDate(day);
  return target.toISOString().slice(0, 10);
}

/**
 * Primer lunes del grid mensual para `dateISO` — el lunes de la semana
 * que contiene el día 1 del mes de `dateISO`.
 */
function firstMondayOfMonthGrid(dateISO: string): string {
  const [y, m] = dateISO.split('-').map(Number);
  const first = new Date(Date.UTC(y!, (m ?? 1) - 1, 1));
  const dow = first.getUTCDay();
  const offset = (dow + 6) % 7; // días atrás hasta el lunes
  const start = new Date(first);
  start.setUTCDate(1 - offset);
  return start.toISOString().slice(0, 10);
}

/**
 * Ancla `dateISO` al anchor esperado por cada vista:
 *   - month → día 1 del mes (así "Agosto 2026" es "2026-08-01").
 *   - week  → LUNES de la semana que contiene `dateISO`.
 *   - day   → tal cual.
 *
 * Es útil al cambiar de tab (evita que la semana arranque en domingo si el
 * user estaba parado en domingo, o que el mes muestre día 15 en el label).
 */
function normalizeDateForView(dateISO: string, view: ViewMode): string {
  if (view === 'month') return `${dateISO.slice(0, 7)}-01`;
  if (view === 'week') {
    const [y, m, d] = dateISO.split('-').map(Number);
    const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
    const dow = new Date(ms).getUTCDay(); // 0=dom … 6=sáb
    const offset = (dow + 6) % 7; // días hacia atrás hasta lunes
    return new Date(ms - offset * 86_400_000).toISOString().slice(0, 10);
  }
  return dateISO;
}

/**
 * Igual que el helper del server — duplicado acá para no crear ida y vuelta
 * de imports client/server. Se usa en la queryFn cuando el user navega y
 * TanStack Query refetchea.
 */
function rangeForClient(
  dateISO: string,
  view: ViewMode,
): { from: Date; to: Date } {
  if (view === 'month') {
    const start = firstMondayOfMonthGrid(dateISO);
    const from = new Date(`${start}T00:00:00.000Z`);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 42);
    return { from, to };
  }
  const from = new Date(`${dateISO}T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + (view === 'week' ? 7 : 1));
  return { from, to };
}
