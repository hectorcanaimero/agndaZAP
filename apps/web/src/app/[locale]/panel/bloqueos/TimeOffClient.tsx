'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { fetcher } from '@/lib/auth';

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

export function TimeOffClient({ locale, rows, professionals }: Props) {
  const t = useTranslations('panel.timeOff');
  const router = useRouter();
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TimeOff | null>(null);

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

  async function deleteOne(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    const res = await fetcher(`/api/time-off/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.push(t('deleted'), 'success');
      router.refresh();
    } else {
      toast.push(t('deleteFailed'), 'error');
    }
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>{t('new')}</Button>
      </div>
      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2">{t('fields.range')}</th>
              <th className="px-3 py-2">{t('fields.professional')}</th>
              <th className="px-3 py-2">{t('fields.reason')}</th>
              <th className="px-3 py-2 text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-6 text-center text-gray-500">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 tabular-nums text-gray-900">
                    {fmt(r.startAt)} → {fmt(r.endAt)}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {profName(r.professionalId)}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{r.reason ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline"
                      onClick={() => setEditing(r)}
                    >
                      {t('edit')}
                    </button>
                    <button
                      type="button"
                      className="ml-3 text-xs text-red-600 hover:underline"
                      onClick={() => deleteOne(r.id)}
                    >
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
  const router = useRouter();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    reset,
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

  async function onSubmit(values: ToffFormValues) {
    const payload = {
      startAt: localToISO(values.startAt),
      endAt: localToISO(values.endAt),
      ...(values.reason ? { reason: values.reason } : {}),
      ...(values.professionalId
        ? { professionalId: values.professionalId }
        : {}),
    };
    const res =
      mode === 'create'
        ? await fetcher('/api/time-off', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await fetcher(`/api/time-off/${row!.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
    if (res.ok) {
      toast.push(t('saved'), 'success');
      reset();
      onClose();
      router.refresh();
    } else {
      toast.push(t('saveFailed'), 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? t('newTitle') : t('editTitle')}
    >
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
          <Select id="toff-prof" {...register('professionalId')}>
            <option value="">{t('allProfessionals')}</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
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
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
