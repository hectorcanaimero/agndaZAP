'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ColumnDef } from '@tanstack/react-table';
import { ArrowUpDown, Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';

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

export function ServicesClient({ services: initialServices, professionals }: Props) {
  const t = useTranslations('panel.services');
  const qc = useQueryClient();

  const [editing, setEditing] = useState<Service | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);

  /*
   * useQuery con `initialData` proveniente del SSR — la primera render usa el
   * server-fetched snapshot y no dispara refetch hasta pasado `staleTime` (30s
   * del makeQueryClient). Toda mutation invalida `queryKeys.services` y el
   * refetch corre automáticamente — adiós `router.refresh()`.
   */
  const { data: services = initialServices } = useQuery({
    queryKey: queryKeys.services,
    queryFn: () => apiQuery<Service[]>('/api/services'),
    initialData: initialServices,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiMutation<void>(`/api/services/${id}`, 'DELETE'),
    onSuccess: () => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: queryKeys.services });
    },
    onError: () => {
      toast.error(t('deleteFailed'));
    },
    onSettled: () => setDeleteTarget(null),
  });

  function performDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id);
  }

  /*
   * Definimos columns dentro del componente para poder capturar `t`,
   * `setEditing` y `setDeleteTarget` en el cell renderer. Usamos `useMemo`
   * para no reasignar en cada render y evitar que TanStack Table pierda el
   * estado interno de sorting/visibility.
   *
   * IDs explícitos en columnas sin accessorKey (professionals, actions) para
   * poder mapearlos en `columnLabels` del DataTable y en el dropdown de
   * visibility.
   */
  const columns = useMemo<ColumnDef<Service>[]>(
    () => [
      {
        accessorKey: 'name',
        id: 'name',
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 px-2 text-xs uppercase tracking-wider text-gray-500"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === 'asc')
            }
          >
            {t('fields.name')}
            <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="font-medium text-gray-900">{row.original.name}</span>
        ),
      },
      {
        accessorKey: 'durationMin',
        id: 'duration',
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 px-2 text-xs uppercase tracking-wider text-gray-500"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === 'asc')
            }
          >
            {t('fields.duration')}
            <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-700">
            {row.original.durationMin} min
            {row.original.bufferMin > 0 ? ` +${row.original.bufferMin}` : ''}
          </span>
        ),
      },
      {
        accessorKey: 'priceCents',
        id: 'price',
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 px-2 text-xs uppercase tracking-wider text-gray-500"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === 'asc')
            }
          >
            {t('fields.price')}
            <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        ),
        cell: ({ row }) =>
          row.original.priceCents !== null ? (
            <span className="tabular-nums text-gray-700">
              ${(row.original.priceCents / 100).toFixed(2)}
            </span>
          ) : (
            <span className="text-gray-400">—</span>
          ),
      },
      {
        id: 'professionals',
        header: () => (
          <span className="text-xs uppercase tracking-wider text-gray-500">
            {t('fields.professionals')}
          </span>
        ),
        cell: ({ row }) => (
          <span className="block max-w-xs truncate text-sm text-gray-600">
            {row.original.professionals.length === 0
              ? '—'
              : row.original.professionals.map((p) => p.name).join(', ')}
          </span>
        ),
      },
      {
        id: 'actions',
        enableHiding: false,
        header: () => (
          <span className="sr-only">{t('actions')}</span>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(row.original)}
              aria-label={t('edit')}
              className="h-8 w-8 p-0"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteTarget(row.original)}
              aria-label={t('delete')}
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ),
      },
    ],
    [t],
  );

  const columnLabels = useMemo(
    () => ({
      name: t('fields.name'),
      duration: t('fields.duration'),
      price: t('fields.price'),
      professionals: t('fields.professionals'),
    }),
    [t],
  );

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>{t('new')}</Button>
      </div>

      {/* Desktop ≥md: shadcn DataTable (sorting + filter + column vis). */}
      <div className="hidden md:block">
        <DataTable
          columns={columns}
          data={services}
          searchKey="name"
          searchPlaceholder={t('searchPlaceholder')}
          emptyMessage={t('empty')}
          columnLabels={columnLabels}
        />
      </div>

      {/*
        Mobile <md: cards. Evita scroll horizontal en el body que rompe
        el patrón de la tabla. Ver spec `docs/ux/2026-08-09-panel-tables-a-cards-en-mobile.md`.
        Acciones con `min-h-11 min-w-11` (WCAG 2.5.5 Target Size 44×44).
      */}
      <div className="space-y-3 md:hidden">
        {services.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            {t('empty')}
          </div>
        ) : (
          services.map((s) => (
            <div
              key={s.id}
              className="rounded-md border border-gray-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-gray-900">{s.name}</p>
                  <p className="mt-1 text-xs tabular-nums text-gray-500">
                    {s.durationMin} min
                    {s.bufferMin > 0 ? ` +${s.bufferMin}` : ''}
                    {s.priceCents !== null
                      ? ` · $${(s.priceCents / 100).toFixed(2)}`
                      : ''}
                  </p>
                  <p className="mt-1 truncate text-xs text-gray-600">
                    {s.professionals.length === 0
                      ? '—'
                      : s.professionals.map((p) => p.name).join(', ')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-brand-700 hover:bg-brand-50"
                    onClick={() => setEditing(s)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-red-600 hover:bg-red-50"
                    onClick={() => setDeleteTarget(s)}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <ServiceFormModal
        open={creating}
        onClose={() => setCreating(false)}
        professionals={professionals}
        mode="create"
      />
      <ServiceFormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        professionals={professionals}
        mode="edit"
        service={editing}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={performDelete}
        title={t('confirmDelete.title')}
        description={t.rich('confirmDelete.description', {
          name: () => (
            <strong className="font-semibold text-gray-900">
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

function ServiceFormModal({
  open,
  onClose,
  professionals,
  mode,
  service,
}: {
  open: boolean;
  onClose: () => void;
  professionals: Professional[];
  mode: 'create' | 'edit';
  service?: Service | null;
}) {
  const t = useTranslations('panel.services');
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: service?.name ?? '',
      durationMin: service?.durationMin ?? 30,
      bufferMin: service?.bufferMin ?? 0,
      priceCents: service?.priceCents ?? undefined,
      professionalIds: service?.professionals.map((p) => p.id) ?? [],
    },
  });

  // Reset defaults al abrir con otro `service`.
  const selected = watch('professionalIds') ?? [];

  function toggleProfessional(id: string) {
    if (selected.includes(id)) {
      setValue(
        'professionalIds',
        selected.filter((p) => p !== id),
      );
    } else {
      setValue('professionalIds', [...selected, id]);
    }
  }

  /*
   * Una sola mutation para create/edit — el path y método se resuelven en el
   * mutationFn a partir del `mode` + `service.id` capturados por closure. Es
   * más simple que dos useMutation separados y comparte el mismo onSuccess.
   */
  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (mode === 'create') {
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
    onSuccess: () => {
      toast.success(t('saved'));
      reset();
      onClose();
      void qc.invalidateQueries({ queryKey: queryKeys.services });
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
    await saveMutation.mutateAsync(payload).catch(() => {
      // el onError ya toasted; swallow para no romper el handleSubmit
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? t('newTitle') : t('editTitle')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3" noValidate>
        <div className="space-y-1">
          <Label htmlFor="svc-name">{t('fields.name')}</Label>
          <Input id="svc-name" {...register('name')} />
          {errors.name ? (
            <p className="text-xs text-red-600">{t('errors.required')}</p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="svc-dur">{t('fields.duration')} (min)</Label>
            <Input
              id="svc-dur"
              type="number"
              min={5}
              {...register('durationMin')}
            />
            {errors.durationMin ? (
              <p className="text-xs text-red-600">{t('errors.required')}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="svc-buf">{t('fields.buffer')} (min)</Label>
            <Input
              id="svc-buf"
              type="number"
              min={0}
              {...register('bufferMin')}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="svc-price">{t('fields.priceCents')}</Label>
          <Input
            id="svc-price"
            type="number"
            min={0}
            placeholder="1500"
            {...register('priceCents')}
          />
          <p className="text-xs text-gray-500">{t('hints.priceCents')}</p>
        </div>
        <div className="space-y-1">
          <Label>{t('fields.professionals')}</Label>
          <div className="space-y-1 rounded-md border border-gray-200 p-2">
            {professionals.length === 0 ? (
              <p className="text-xs text-gray-500">{t('noProfessionals')}</p>
            ) : (
              professionals.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 text-sm text-gray-700"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={() => toggleProfessional(p.id)}
                    className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  {p.name}
                </label>
              ))
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting || saveMutation.isPending}>
            {isSubmitting || saveMutation.isPending ? t('saving') : t('save')}
          </Button>
        </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
