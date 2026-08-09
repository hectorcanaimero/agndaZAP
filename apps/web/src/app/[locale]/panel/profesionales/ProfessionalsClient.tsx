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

export function ProfessionalsClient({ professionals, services }: Props) {
  const t = useTranslations('panel.professionals');
  const router = useRouter();
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Professional | null>(null);

  async function deleteOne(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    const res = await fetcher(`/api/professionals/${id}`, { method: 'DELETE' });
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
              <th className="px-3 py-2">{t('fields.services')}</th>
              <th className="px-3 py-2 text-right">{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {professionals.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-6 text-center text-gray-500">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              professionals.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {p.name}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {p.services.length === 0
                      ? '—'
                      : p.services.map((s) => s.name).join(', ')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-brand-700 hover:underline"
                      onClick={() => setEditing(p)}
                    >
                      {t('edit')}
                    </button>
                    <button
                      type="button"
                      className="ml-3 text-xs text-red-600 hover:underline"
                      onClick={() => deleteOne(p.id)}
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
  const router = useRouter();
  const toast = useToast();

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

  async function onSubmit(values: ProfFormValues) {
    const payload = {
      name: values.name,
      serviceIds: values.serviceIds,
    };
    const res =
      mode === 'create'
        ? await fetcher('/api/professionals', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await fetcher(`/api/professionals/${professional!.id}`, {
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
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
