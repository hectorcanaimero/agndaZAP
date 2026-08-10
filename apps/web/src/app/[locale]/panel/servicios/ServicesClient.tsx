'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  DollarSign,
  Plus,
  Search,
  Sparkles,
  Trash2,
  User,
  Users,
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

interface Service {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  priceCents: number | null;
  professionals: Array<{ id: string; name: string }>;
}

interface Professional {
  id: string;
  name: string;
}

interface Props {
  services: Service[];
  professionals: Professional[];
}

const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  durationMin: z.coerce.number().int().min(5),
  bufferMin: z.coerce.number().int().min(0).optional(),
  priceCents: z.coerce.number().int().min(0).optional(),
  professionalIds: z.array(z.string()).default([]),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

/**
 * Estado del panel derecho:
 *  - `empty`    → no hay selección; muestra empty state con CTA.
 *  - `create`   → panel vacío en modo "nueva".
 *  - `edit:ID`  → editando el servicio ID.
 */
type PanelMode =
  | { kind: 'empty' }
  | { kind: 'create' }
  | { kind: 'edit'; service: Service };

/* ═══════════════════════════════════════════════════════════════════
 *                        SERVICES CLIENT (root)
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Layout master-detail 2-col:
 *  - Izq (~380px): lista custom con search + CTA "Nuevo". Row activo con
 *    marker vertical brand (mismo lenguaje que conversaciones).
 *  - Der (flex): panel dual-state — empty con carácter o form inline.
 *
 * Mobile (<md): solo la lista full-width. Seleccionar/crear abre un `Sheet`
 * desde la derecha con el mismo form (respeta touch targets del panel).
 *
 * NO usamos DataTable acá — 5-15 servicios promedio por clínica no justifican
 * sorting/column-visibility. La lista custom permite jerarquía visual clara
 * (nombre grande, meta compacta, chips de profesionales) que la tabla no daba.
 */
export function ServicesClient({
  services: initialServices,
  professionals,
}: Props) {
  const t = useTranslations('panel.services');
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const { data: services = initialServices } = useQuery({
    queryKey: queryKeys.services,
    queryFn: () => apiQuery<Service[]>('/api/services'),
    initialData: initialServices,
    // 30s antes de considerar stale — evita refetch loops si el user hace
    // muchas mutations seguidas.
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return services;
    return services.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.professionals.some((p) => p.name.toLowerCase().includes(q)),
    );
  }, [services, search]);

  const activeId =
    panel.kind === 'edit' ? panel.service.id : null;

  /* ─────── Mutations ─────── */

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/services/${id}`, 'DELETE'),
    onSuccess: (_data, deletedId) => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: queryKeys.services });
      // Si borramos el servicio activo, volvemos a empty (sino el panel muestra
      // datos de un servicio inexistente hasta el próximo click).
      if (panel.kind === 'edit' && panel.service.id === deletedId) {
        setPanel({ kind: 'empty' });
        setMobileSheetOpen(false);
      }
    },
    onError: () => {
      toast.error(t('deleteFailed'));
    },
    onSettled: () => setDeleteTarget(null),
  });

  /* ─────── Handlers ─────── */

  // El Sheet mobile es controlled → si lo abrimos en desktop, Radix igual
  // renderiza el overlay/backdrop del portal aunque el content tenga md:hidden
  // (el overlay NO hereda esa clase). Guard con matchMedia para abrir solo
  // cuando corresponde. En desktop el panel derecho ya es visible, no hace
  // falta drawer.
  function isMobileViewport(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767.98px)').matches;
  }

  function openCreate() {
    setPanel({ kind: 'create' });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function openEdit(s: Service) {
    setPanel({ kind: 'edit', service: s });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    setMobileSheetOpen(false);
  }

  function handleFormSuccess(saved: Service, wasCreate: boolean) {
    // Después de guardar, mantenemos el servicio en el panel en modo edición —
    // el operador puede seguir tocándolo o volver a la lista con "cerrar".
    setPanel({ kind: 'edit', service: saved });
    if (wasCreate) {
      // En mobile, tras crear cerramos el sheet para que el user vea la lista
      // actualizada. En desktop lo dejamos abierto para permitir tweaks.
      setMobileSheetOpen(false);
    }
  }

  /* ─────── Render ─────── */

  const panelContent =
    panel.kind === 'empty' ? (
      <EmptyPanel onCreate={openCreate} />
    ) : (
      <ServiceForm
        // key remonta el useForm cuando cambia el modo/servicio (evita defaults
        // de stale). Sin esto, al pasar de edit A → edit B, el form muestra A.
        key={panel.kind === 'edit' ? panel.service.id : 'new'}
        mode={panel}
        professionals={professionals}
        onClose={closePanel}
        onSuccess={handleFormSuccess}
        onDelete={(s) => setDeleteTarget(s)}
      />
    );

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* ─────────  IZQUIERDA — LISTA  ───────── */}
        <aside className="flex min-h-0 w-full flex-col border-r border-border/60 md:w-[380px] md:shrink-0">
          {/* Toolbar: search + count + CTA */}
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
              {t('countLabel', { n: services.length })}
              {search && filtered.length !== services.length ? (
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
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1">
              {filtered.map((s) => (
                <li key={s.id}>
                  <ServiceRow
                    service={s}
                    active={s.id === activeId}
                    onSelect={() => openEdit(s)}
                    t={t}
                  />
                </li>
              ))}
            </ul>
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
          name: () => (
            <strong className="font-semibold text-foreground">
              {deleteTarget?.name ?? ''}
            </strong>
          ),
        })}
        confirmLabel={t('delete')}
        variant="destructive"
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            SERVICE ROW
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Row de la lista izquierda. Diseño compacto pero con jerarquía:
 *   - Nombre grande (font-medium)
 *   - Meta compacta con duration + price (números tabular)
 *   - Chips de profesionales con inicial + color estable por hash
 *   - Marker vertical brand a la izquierda cuando está activo (patrón conversaciones)
 */
function ServiceRow({
  service,
  active,
  onSelect,
  t,
}: {
  service: Service;
  active: boolean;
  onSelect: () => void;
  t: ReturnType<typeof useTranslations<'panel.services'>>;
}) {
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
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {service.name}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {service.durationMin}
            {service.bufferMin > 0 ? `+${service.bufferMin}` : ''} min
          </span>
          {service.priceCents !== null ? (
            <>
              <span aria-hidden="true">·</span>
              <span>${(service.priceCents / 100).toFixed(2)}</span>
            </>
          ) : null}
        </p>
        <p
          className={cn(
            'mt-1 flex items-center gap-1 text-[11px]',
            service.professionals.length === 0
              ? 'italic text-muted-foreground'
              : 'text-muted-foreground',
          )}
        >
          {service.professionals.length === 0 ? (
            <>
              <User className="h-3 w-3" aria-hidden="true" />
              {t('noProfessionalsRow')}
            </>
          ) : (
            <>
              <Users className="h-3 w-3" aria-hidden="true" />
              <span className="tabular-nums">
                {t('professionalCount', {
                  n: service.professionals.length,
                })}
              </span>
            </>
          )}
        </p>
      </div>
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            EMPTY PANEL
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Estado vacío del panel derecho. SVG inline con líneas orgánicas + CTA.
 * NO usar imágenes decorativas genéricas — vale más un dibujo inline con
 * personalidad que un `<Sparkles>` de lucide sin contexto.
 */
function EmptyPanel({ onCreate }: { onCreate: () => void }) {
  const t = useTranslations('panel.services');
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
          {/* Círculo suave de fondo */}
          <circle cx="60" cy="60" r="52" className="fill-brand-50" />
          {/* Reloj estilizado */}
          <circle
            cx="60"
            cy="60"
            r="30"
            stroke="currentColor"
            strokeWidth="1.5"
            className="opacity-40"
          />
          <path
            d="M60 42v18l12 8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Marcadores de horas — solo 4 para no saturar */}
          {[0, 90, 180, 270].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const x1 = 60 + Math.sin(rad) * 26;
            const y1 = 60 - Math.cos(rad) * 26;
            const x2 = 60 + Math.sin(rad) * 30;
            const y2 = 60 - Math.cos(rad) * 30;
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
          {/* Sparkle decorativo */}
          <path
            d="M96 32l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z"
            className="fill-amber-400"
          />
          <path
            d="M22 88l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
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
 *                            SERVICE FORM
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Form inline (no modal). Header con nombre + acciones (cerrar/eliminar),
 * body con los 5 campos y footer sticky con Cancelar + Guardar.
 *
 * Comparte la MISMA schema y la MISMA API que el modal anterior. Solo
 * cambia el chrome — cero cambios en backend contracts.
 */
function ServiceForm({
  mode,
  professionals,
  onClose,
  onSuccess,
  onDelete,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; service: Service };
  professionals: Professional[];
  onClose: () => void;
  onSuccess: (saved: Service, wasCreate: boolean) => void;
  onDelete: (service: Service) => void;
}) {
  const t = useTranslations('panel.services');
  const qc = useQueryClient();
  const isEdit = mode.kind === 'edit';
  const service = isEdit ? mode.service : null;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: service?.name ?? '',
      durationMin: service?.durationMin ?? 30,
      bufferMin: service?.bufferMin ?? 0,
      priceCents: service?.priceCents ?? undefined,
      professionalIds: service?.professionals?.map((p) => p.id) ?? [],
    },
  });

  // Re-reset cuando cambia el servicio (por si React reusa la instancia — el
  // `key` en el padre debería evitarlo pero es defensa en profundidad).
  useEffect(() => {
    reset({
      name: service?.name ?? '',
      durationMin: service?.durationMin ?? 30,
      bufferMin: service?.bufferMin ?? 0,
      priceCents: service?.priceCents ?? undefined,
      professionalIds: service?.professionals?.map((p) => p.id) ?? [],
    });
    // Sólo reset al cambiar el servicio identificado por id — evita re-resets
    // en cada render y perdida de estado que el user está tipeando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.id]);

  const selected = watch('professionalIds') ?? [];

  function toggleProfessional(id: string) {
    if (selected.includes(id)) {
      setValue(
        'professionalIds',
        selected.filter((p) => p !== id),
        { shouldDirty: true },
      );
    } else {
      setValue('professionalIds', [...selected, id], { shouldDirty: true });
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!isEdit) {
        return apiMutation<Service, Record<string, unknown>>(
          '/api/services',
          'POST',
          payload,
        );
      }
      return apiMutation<Service, Record<string, unknown>>(
        `/api/services/${service!.id}`,
        'PATCH',
        payload,
      );
    },
    onSuccess: (saved) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: queryKeys.services });
      onSuccess(saved, !isEdit);
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ServiceFormValues) {
    const payload = {
      name: values.name,
      durationMin: values.durationMin,
      ...(values.bufferMin !== undefined ? { bufferMin: values.bufferMin } : {}),
      ...(values.priceCents !== undefined
        ? { priceCents: values.priceCents }
        : {}),
      professionalIds: values.professionalIds,
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
            {isEdit ? service!.name : t('newSubtitle')}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onDelete(service!)}
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
        {/* Nombre */}
        <div className="space-y-1.5">
          <Label htmlFor="svc-name">{t('fields.name')}</Label>
          <Input
            id="svc-name"
            {...register('name')}
            disabled={busy}
            placeholder={t('placeholders.name')}
          />
          {errors.name ? (
            <p className="text-xs text-destructive">{t('errors.required')}</p>
          ) : null}
        </div>

        {/* Duración + Buffer */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="svc-dur" className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              {t('fields.duration')}{' '}
              <span className="text-xs text-muted-foreground">(min)</span>
            </Label>
            <Input
              id="svc-dur"
              type="number"
              min={5}
              step={5}
              {...register('durationMin')}
              disabled={busy}
            />
            {errors.durationMin ? (
              <p className="text-xs text-destructive">
                {t('errors.required')}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="svc-buf">
              {t('fields.buffer')}{' '}
              <span className="text-xs text-muted-foreground">(min)</span>
            </Label>
            <Input
              id="svc-buf"
              type="number"
              min={0}
              step={5}
              {...register('bufferMin')}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('hints.buffer')}
            </p>
          </div>
        </div>

        {/* Precio */}
        <div className="space-y-1.5">
          <Label htmlFor="svc-price" className="flex items-center gap-1.5">
            <DollarSign
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {t('fields.priceCents')}
          </Label>
          <Input
            id="svc-price"
            type="number"
            min={0}
            placeholder="1500"
            {...register('priceCents')}
            disabled={busy}
          />
          <p className="text-[11px] text-muted-foreground">
            {t('hints.priceCents')}
          </p>
        </div>

        {/* Profesionales */}
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            <Users
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {t('fields.professionals')}
            {selected.length > 0 ? (
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                {t('selectedCount', { n: selected.length })}
              </span>
            ) : null}
          </Label>
          {professionals.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('noProfessionals')}
              </p>
            </div>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
              {professionals.map((p) => {
                const checked = selected.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                      checked
                        ? 'bg-brand-50 text-foreground'
                        : 'hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleProfessional(p.id)}
                      disabled={busy}
                      className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
                    />
                    <span className="flex-1 truncate">{p.name}</span>
                  </label>
                );
              })}
            </div>
          )}
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
