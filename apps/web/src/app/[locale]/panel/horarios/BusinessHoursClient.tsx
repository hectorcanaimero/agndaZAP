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

/**
 * Zod schema. `startTime` y `endTime` como strings `HH:mm` — el usuario los
 * ingresa así. Convertimos a `startMinutes`/`endMinutes` (int 0..1440) antes
 * de enviar al backend.
 */
const bhSchema = z
  .object({
    weekday: z.coerce.number().int().min(0).max(6),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    professionalId: z.string().optional(),
  })
  .refine(
    (v) => toMinutes(v.endTime) > toMinutes(v.startTime),
    { message: 'endTime > startTime', path: ['endTime'] },
  );

type BhFormValues = z.infer<typeof bhSchema>;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function BusinessHoursClient({
  hours: initialHours,
  professionals,
}: Props) {
  const t = useTranslations('panel.businessHours');
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BusinessHour | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BusinessHour | null>(null);

  /*
   * BusinessHours no filtra por professional en el server acá (siempre traemos
   * la lista completa). La key `businessHours()` sin argumento resuelve a
   * 'all' — misma cache tras invalidación.
   */
  const { data: hours = initialHours } = useQuery({
    queryKey: queryKeys.businessHours(),
    queryFn: () => apiQuery<BusinessHour[]>('/api/business-hours'),
    initialData: initialHours,
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

  function findProf(id: string | null): string {
    if (!id) return t('allProfessionals');
    return professionals.find((p) => p.id === id)?.name ?? id;
  }

  /**
   * Un `BusinessHour` no tiene `name` propio — el "ítem" es identificado por
   * día + rango horario + profesional. Componemos un label legible para el
   * ConfirmDialog.
   */
  function labelFor(h: BusinessHour): string {
    return `${weekdayLabels[h.weekday]} ${toHHMM(h.startMinutes)}–${toHHMM(h.endMinutes)} · ${findProf(h.professionalId)}`;
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/business-hours/${id}`, 'DELETE'),
    onSuccess: () => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: ['businessHours'] });
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

  const columns = useMemo<ColumnDef<BusinessHour>[]>(
    () => [
      {
        accessorKey: 'weekday',
        id: 'weekday',
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 px-2 text-xs uppercase tracking-wider text-gray-500"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === 'asc')
            }
          >
            {t('fields.weekday')}
            <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="text-gray-900">
            {weekdayLabels[row.original.weekday]}
          </span>
        ),
      },
      {
        accessorKey: 'startMinutes',
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
          <span className="tabular-nums text-gray-700">
            {toHHMM(row.original.startMinutes)} –{' '}
            {toHHMM(row.original.endMinutes)}
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
            {findProf(row.original.professionalId)}
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
    // findProf depende de `professionals`; weekdayLabels depende de `t`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, weekdayLabels, professionals],
  );

  const columnLabels = useMemo(
    () => ({
      weekday: t('fields.weekday'),
      range: t('fields.range'),
      professional: t('fields.professional'),
    }),
    [t],
  );

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>{t('new')}</Button>
      </div>

      {/* Desktop ≥md: shadcn DataTable (sort weekday/range, no search). */}
      <div className="hidden md:block">
        <DataTable
          columns={columns}
          data={hours}
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
        {hours.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            {t('empty')}
          </div>
        ) : (
          hours.map((h) => (
            <div
              key={h.id}
              className="rounded-md border border-gray-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900">
                    {weekdayLabels[h.weekday]}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-gray-500">
                    {toHHMM(h.startMinutes)} – {toHHMM(h.endMinutes)}
                  </p>
                  <p className="mt-1 truncate text-xs text-gray-600">
                    {findProf(h.professionalId)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-brand-700 hover:bg-brand-50"
                    onClick={() => setEditing(h)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm text-red-600 hover:bg-red-50"
                    onClick={() => setDeleteTarget(h)}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <BhFormModal
        open={creating}
        onClose={() => setCreating(false)}
        professionals={professionals}
        mode="create"
      />
      <BhFormModal
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

function BhFormModal({
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
  row?: BusinessHour | null;
}) {
  const t = useTranslations('panel.businessHours');
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<BhFormValues>({
    resolver: zodResolver(bhSchema),
    defaultValues: {
      weekday: row?.weekday ?? 1,
      startTime: row ? toHHMM(row.startMinutes) : '09:00',
      endTime: row ? toHHMM(row.endMinutes) : '18:00',
      professionalId: row?.professionalId ?? '',
    },
  });

  const weekday = watch('weekday');
  const professionalId = watch('professionalId');

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (mode === 'create') {
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
    onSuccess: () => {
      toast.success(t('saved'));
      reset();
      onClose();
      void qc.invalidateQueries({ queryKey: ['businessHours'] });
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
          <Label htmlFor="bh-weekday">{t('fields.weekday')}</Label>
          <Select
            value={String(weekday)}
            onValueChange={(v) =>
              setValue('weekday', Number(v), { shouldValidate: true })
            }
          >
            <SelectTrigger id="bh-weekday">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0, 1, 2, 3, 4, 5, 6].map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {t(`weekdays.${w}` as const)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="bh-start">{t('fields.start')}</Label>
            <Input id="bh-start" type="time" {...register('startTime')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bh-end">{t('fields.end')}</Label>
            <Input id="bh-end" type="time" {...register('endTime')} />
            {errors.endTime ? (
              <p className="text-xs text-red-600">{t('errors.rangeInvalid')}</p>
            ) : null}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="bh-prof">{t('fields.professional')}</Label>
          {/*
            Radix Select no acepta value="" — usamos "__all" como sentinel para
            representar "todos los profesionales" y lo mapeamos a '' antes de
            guardar en el form value.
          */}
          <Select
            value={professionalId ? professionalId : '__all'}
            onValueChange={(v) =>
              setValue('professionalId', v === '__all' ? '' : v, {
                shouldValidate: true,
              })
            }
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
