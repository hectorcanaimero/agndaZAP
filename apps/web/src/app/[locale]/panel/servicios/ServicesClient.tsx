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
import { useToast } from '@/components/ui/toast';
import { fetcher } from '@/lib/auth';

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

export function ServicesClient({ services, professionals }: Props) {
  const t = useTranslations('panel.services');
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Service | null>(null);
  const [creating, setCreating] = useState(false);

  async function deleteOne(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    const res = await fetcher(`/api/services/${id}`, { method: 'DELETE' });
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
              <th className="px-3 py-2">{t('fields.name')}</th>
              <th className="px-3 py-2">{t('fields.duration')}</th>
              <th className="px-3 py-2">{t('fields.price')}</th>
              <th className="px-3 py-2">{t('fields.professionals')}</th>
              <th className="px-3 py-2 text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {services.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-gray-500">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              services.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {s.name}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700">
                    {s.durationMin} min
                    {s.bufferMin > 0 ? ` +${s.bufferMin}` : ''}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-700">
                    {s.priceCents !== null
                      ? `$${(s.priceCents / 100).toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {s.professionals.length === 0
                      ? '—'
                      : s.professionals.map((p) => p.name).join(', ')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline"
                      onClick={() => setEditing(s)}
                    >
                      {t('edit')}
                    </button>
                    <button
                      type="button"
                      className="ml-3 text-xs text-red-600 hover:underline"
                      onClick={() => deleteOne(s.id)}
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
  const router = useRouter();
  const toast = useToast();

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

    const res =
      mode === 'create'
        ? await fetcher('/api/services', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await fetcher(`/api/services/${service!.id}`, {
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
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
