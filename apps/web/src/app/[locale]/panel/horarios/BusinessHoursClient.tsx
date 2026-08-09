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

export function BusinessHoursClient({ hours, professionals }: Props) {
  const t = useTranslations('panel.businessHours');
  const router = useRouter();
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BusinessHour | null>(null);

  const weekdayLabels = [
    t('weekdays.0'),
    t('weekdays.1'),
    t('weekdays.2'),
    t('weekdays.3'),
    t('weekdays.4'),
    t('weekdays.5'),
    t('weekdays.6'),
  ];

  function findProf(id: string | null): string {
    if (!id) return t('allProfessionals');
    return professionals.find((p) => p.id === id)?.name ?? id;
  }

  async function deleteOne(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    const res = await fetcher(`/api/business-hours/${id}`, { method: 'DELETE' });
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
              <th className="px-3 py-2">{t('fields.weekday')}</th>
              <th className="px-3 py-2">{t('fields.range')}</th>
              <th className="px-3 py-2">{t('fields.professional')}</th>
              <th className="px-3 py-2 text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {hours.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-6 text-center text-gray-500">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              hours.map((h) => (
                <tr key={h.id}>
                  <td className="px-3 py-2 text-gray-900">
                    {weekdayLabels[h.weekday]}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700">
                    {toHHMM(h.startMinutes)} – {toHHMM(h.endMinutes)}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {findProf(h.professionalId)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline"
                      onClick={() => setEditing(h)}
                    >
                      {t('edit')}
                    </button>
                    <button
                      type="button"
                      className="ml-3 text-xs text-red-600 hover:underline"
                      onClick={() => deleteOne(h.id)}
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
  const router = useRouter();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    reset,
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

  async function onSubmit(values: BhFormValues) {
    const payload = {
      weekday: values.weekday,
      startMinutes: toMinutes(values.startTime),
      endMinutes: toMinutes(values.endTime),
      ...(values.professionalId
        ? { professionalId: values.professionalId }
        : {}),
    };
    const res =
      mode === 'create'
        ? await fetcher('/api/business-hours', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await fetcher(`/api/business-hours/${row!.id}`, {
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
        <div className="space-y-1">
          <Label htmlFor="bh-weekday">{t('fields.weekday')}</Label>
          <Select id="bh-weekday" {...register('weekday')}>
            {[0, 1, 2, 3, 4, 5, 6].map((w) => (
              <option key={w} value={w}>
                {t(`weekdays.${w}` as const)}
              </option>
            ))}
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
          <Select id="bh-prof" {...register('professionalId')}>
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
