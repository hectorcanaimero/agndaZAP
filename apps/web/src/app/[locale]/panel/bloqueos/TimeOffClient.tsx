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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';

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

/**
 * Zod schema. Usa `datetime-local` (formato `YYYY-MM-DDTHH:mm`). Convertimos
 * a ISO 8601 con offset local antes de enviar. El backend parsea con Luxon
 * usando la TZ de la clínica — pero como el input viene con offset local
 * del navegador, el backend interpreta correctamente.
 */
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

/** ISO `YYYY-MM-DDTHH:mm` compatible con `<input type="datetime-local">`. */
function toLocalDatetimeString(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  // El input `datetime-local` no trae offset. Interpretamos como hora local
  // del navegador — que en el panel es hora de la clínica (asumiendo que el
  // recepcionista opera en el mismo TZ). El backend re-parsea con la TZ real
  // de la clínica, así que este ISO viaja como referencia y se re-anchoreamos
  // server-side.
  const d = new Date(local);
  return d.toISOString();
}

export function TimeOffClient({
  locale,
  rows: initialRows,
  professionals,
}: Props) {
  const t = useTranslations('panel.timeOff');
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TimeOff | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimeOff | null>(null);

  const { data: rows = initialRows } = useQuery({
    queryKey: queryKeys.timeOff(),
    queryFn: () => apiQuery<TimeOff[]>('/api/time-off'),
    initialData: initialRows,
  });

  function fmt(iso: string): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false,
    }).format(new Date(iso));
  }

  function profName(id: string | null): string {
    if (!id) return t('allProfessionals');
    return professionals.find((p) => p.id === id)?.name ?? id;
  }

  /**
   * TimeOff no tiene `name`. Componemos un label con rango + profesional
   * (+ motivo si existe) para dar contexto al operador antes de eliminar.
   */
  function labelFor(r: TimeOff): string {
    const range = `${fmt(r.startAt)} → ${fmt(r.endAt)}`;
    const prof = profName(r.professionalId);
    return r.reason ? `${range} · ${prof} · ${r.reason}` : `${range} · ${prof}`;
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiMutation<void>(`/api/time-off/${id}`, 'DELETE'),
    onSuccess: () => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: ['timeOff'] });
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

  const columns = useMemo<ColumnDef<TimeOff>[]>(
    () => [
      {
        accessorKey: 'startAt',
        id: 'range',
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 px-2 text-xs uppercase tracking-wider text-gray-500"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === 'asc')
            }
          >
            {t('fields.range')}
            <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-900">
            {fmt(row.original.startAt)} → {fmt(row.original.endAt)}
          </span>
        ),
      },
      {
        id: 'professional',
        header: () => (
          <span className="text-xs uppercase tracking-wider text-gray-500">
            {t('fields.professional')}
          </span>
        ),
        cell: ({ row }) => (
          <span className="text-sm text-gray-600">
            {profName(row.original.professionalId)}
          </span>
        ),
      },
      {
        accessorKey: 'reason',
        id: 'reason',
        header: () => (
          <span className="text-xs uppercase tracking-wider text-gray-500">
            {t('fields.reason')}
          </span>
        ),
        cell: ({ row }) =>
          row.original.reason ? (
            <span className="text-sm text-gray-600">{row.original.reason}</span>
          ) : (
            <span className="text-gray-400">—</span>
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
    // fmt y profName cierran sobre `locale` y `professionals`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, locale, professionals],
  );

  const columnLabels = useMemo(
    () => ({
      range: t('fields.range'),
      professional: t('fields.professional'),
      reason: t('fields.reason'),
    }),
    [t],
  );

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>{t('new')}</Button>
      </div>

      {/* Desktop ≥md: shadcn DataTable (sort startAt, search en reason). */}
      <div className="hidden md:block">
        <DataTable
          columns={columns}
          data={rows}
          searchKey="reason"
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
        {rows.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            {t('empty')}
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="rounded-md border border-gray-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium tabular-nums text-gray-900">
                    {fmt(r.startAt)} → {fmt(r.endAt)}
                  </p>
                  <p className="mt-1 truncate text-xs text-gray-600">
                    {profName(r.professionalId)}
                  </p>
                  {r.reason ? (
                    <p className="mt-1 truncate text-xs text-gray-500">
                      {r.reason}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-brand-700 hover:bg-brand-50"
                    onClick={() => setEditing(r)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-red-600 hover:bg-red-50"
                    onClick={() => setDeleteTarget(r)}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <ToffFormModal
        open={creating}
        onClose={() => setCreating(false)}
        professionals={professionals}
        mode="create"
      />
      <ToffFormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        professionals={professionals}
        mode="edit"
        row={editing}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={performDelete}
        title={t('confirmDelete.title')}
        description={t.rich('confirmDelete.description', {
          name: () => (
            <strong className="font-semibold text-gray-900">
              {deleteTarget ? labelFor(deleteTarget) : ''}
            </strong>
          ),
          warn: (chunks) => (
            <strong className="font-semibold text-red-700">{chunks}</strong>
          ),
        })}
        confirmLabel={t('delete')}
        variant="destructive"
      />
    </>
  );
}

function ToffFormModal({
  open,
  onClose,
  professionals,
  mode,
  row,
}: {
  open: boolean;
  onClose: () => void;
  professionals: ProfessionalLite[];
  mode: 'create' | 'edit';
  row?: TimeOff | null;
}) {
  const t = useTranslations('panel.timeOff');
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ToffFormValues>({
    resolver: zodResolver(toffSchema),
    defaultValues: {
      startAt: row ? toLocalDatetimeString(row.startAt) : '',
      endAt: row ? toLocalDatetimeString(row.endAt) : '',
      reason: row?.reason ?? '',
      professionalId: row?.professionalId ?? '',
    },
  });

  const professionalId = watch('professionalId');

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (mode === 'create') {
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
    onSuccess: () => {
      toast.success(t('saved'));
      reset();
      onClose();
      void qc.invalidateQueries({ queryKey: ['timeOff'] });
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ToffFormValues) {
    const payload = {
      startAt: localToISO(values.startAt),
      endAt: localToISO(values.endAt),
      ...(values.reason ? { reason: values.reason } : {}),
      ...(values.professionalId
        ? { professionalId: values.professionalId }
        : {}),
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
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="toff-start">{t('fields.start')}</Label>
            <Input
              id="toff-start"
              type="datetime-local"
              {...register('startAt')}
            />
            {errors.startAt ? (
              <p className="text-xs text-red-600">{t('errors.required')}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="toff-end">{t('fields.end')}</Label>
            <Input
              id="toff-end"
              type="datetime-local"
              {...register('endAt')}
            />
            {errors.endAt ? (
              <p className="text-xs text-red-600">{t('errors.rangeInvalid')}</p>
            ) : null}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="toff-reason">{t('fields.reason')}</Label>
          <Input
            id="toff-reason"
            maxLength={200}
            placeholder={t('placeholders.reason')}
            {...register('reason')}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="toff-prof">{t('fields.professional')}</Label>
          <Select
            value={professionalId ? professionalId : '__all'}
            onValueChange={(v) =>
              setValue('professionalId', v === '__all' ? '' : v, {
                shouldValidate: true,
              })
            }
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
