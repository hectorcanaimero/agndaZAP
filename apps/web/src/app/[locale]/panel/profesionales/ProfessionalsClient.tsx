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

interface Professional {
  id: string;
  name: string;
  services: Array<{ id: string; name: string }>;
}

interface ServiceLite {
  id: string;
  name: string;
}

interface Props {
  professionals: Professional[];
  services: ServiceLite[];
}

const profSchema = z.object({
  name: z.string().trim().min(2).max(120),
  serviceIds: z.array(z.string()).default([]),
});

type ProfFormValues = z.infer<typeof profSchema>;

export function ProfessionalsClient({
  professionals: initialProfessionals,
  services,
}: Props) {
  const t = useTranslations('panel.professionals');
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Professional | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Professional | null>(null);

  /*
   * useQuery hidratado desde el SSR — `initialData` evita el flash "loading"
   * y arranca ya con la lista pintada. La mutation invalida y refetchea.
   */
  const { data: professionals = initialProfessionals } = useQuery({
    queryKey: queryKeys.professionals,
    queryFn: () => apiQuery<Professional[]>('/api/professionals'),
    initialData: initialProfessionals,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/professionals/${id}`, 'DELETE'),
    onSuccess: () => {
      toast.success(t('deleted'));
      // Invalidar también `services` porque los profesionales están embebidos
      // en cada Service (relación many-to-many). Elimina un profesional →
      // desaparece del listado de servicios que lo tenían.
      void qc.invalidateQueries({ queryKey: queryKeys.professionals });
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

  const columns = useMemo<ColumnDef<Professional>[]>(
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
        id: 'services',
        header: () => (
          <span className="text-xs uppercase tracking-wider text-gray-500">
            {t('fields.services')}
          </span>
        ),
        cell: ({ row }) => (
          <span className="block max-w-md truncate text-sm text-gray-600">
            {row.original.services.length === 0
              ? '—'
              : row.original.services.map((s) => s.name).join(', ')}
          </span>
        ),
      },
      {
        id: 'actions',
        enableHiding: false,
        header: () => <span className="sr-only">{t('actions')}</span>,
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
      services: t('fields.services'),
    }),
    [t],
  );

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>{t('new')}</Button>
      </div>

      {/* Desktop ≥md: shadcn DataTable (sort by name, global search). */}
      <div className="hidden md:block">
        <DataTable
          columns={columns}
          data={professionals}
          searchKey="name"
          searchPlaceholder={t('searchPlaceholder')}
          emptyMessage={t('empty')}
          columnLabels={columnLabels}
        />
      </div>

      {/*
        Mobile <md: cards. Ver spec
        `docs/ux/2026-08-09-panel-tables-a-cards-en-mobile.md`.
        Acciones con `min-h-11 min-w-11` (WCAG 2.5.5).
      */}
      <div className="space-y-3 md:hidden">
        {professionals.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            {t('empty')}
          </div>
        ) : (
          professionals.map((p) => (
            <div
              key={p.id}
              className="rounded-md border border-gray-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-gray-900">{p.name}</p>
                  <p className="mt-1 truncate text-xs text-gray-600">
                    {p.services.length === 0
                      ? '—'
                      : p.services.map((s) => s.name).join(', ')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-brand-700 hover:bg-brand-50"
                    onClick={() => setEditing(p)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-red-600 hover:bg-red-50"
                    onClick={() => setDeleteTarget(p)}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <ProfFormModal
        open={creating}
        onClose={() => setCreating(false)}
        services={services}
        mode="create"
      />
      <ProfFormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        services={services}
        mode="edit"
        professional={editing}
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

function ProfFormModal({
  open,
  onClose,
  services,
  mode,
  professional,
}: {
  open: boolean;
  onClose: () => void;
  services: ServiceLite[];
  mode: 'create' | 'edit';
  professional?: Professional | null;
}) {
  const t = useTranslations('panel.professionals');
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ProfFormValues>({
    resolver: zodResolver(profSchema),
    defaultValues: {
      name: professional?.name ?? '',
      serviceIds: professional?.services.map((s) => s.id) ?? [],
    },
  });

  const selected = watch('serviceIds') ?? [];

  function toggle(id: string) {
    if (selected.includes(id)) {
      setValue('serviceIds', selected.filter((s) => s !== id));
    } else {
      setValue('serviceIds', [...selected, id]);
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (mode === 'create') {
        return apiMutation<Professional, Record<string, unknown>>(
          '/api/professionals',
          'POST',
          payload,
        );
      }
      return apiMutation<Professional, Record<string, unknown>>(
        `/api/professionals/${professional!.id}`,
        'PATCH',
        payload,
      );
    },
    onSuccess: () => {
      toast.success(t('saved'));
      reset();
      onClose();
      // Igual que en delete: cambiar servicios asociados de un profesional
      // impacta la lista de `services` (que embebe `professionals`).
      void qc.invalidateQueries({ queryKey: queryKeys.professionals });
      void qc.invalidateQueries({ queryKey: queryKeys.services });
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ProfFormValues) {
    const payload = {
      name: values.name,
      serviceIds: values.serviceIds,
    };
    await saveMutation.mutateAsync(payload).catch(() => {
      /* onError toasted */
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
          <Label htmlFor="prof-name">{t('fields.name')}</Label>
          <Input id="prof-name" {...register('name')} />
          {errors.name ? (
            <p className="text-xs text-red-600">{t('errors.required')}</p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label>{t('fields.services')}</Label>
          <div className="space-y-1 rounded-md border border-gray-200 p-2">
            {services.length === 0 ? (
              <p className="text-xs text-gray-500">{t('noServices')}</p>
            ) : (
              services.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 text-sm text-gray-700"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  {s.name}
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
