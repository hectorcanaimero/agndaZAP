'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { fetcher } from '@/lib/auth';

interface FaqChunk {
  id: string;
  content: string;
  createdAt: string;
}

const faqSchema = z.object({
  content: z.string().trim().min(5).max(4000),
});

type FaqFormValues = z.infer<typeof faqSchema>;

interface Props {
  locale: string;
  rows: FaqChunk[];
}

export function FaqClient({ locale, rows }: Props) {
  const t = useTranslations('panel.faq');
  const router = useRouter();
  const toast = useToast();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FaqChunk | null>(null);

  async function deleteOne(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    const res = await fetcher(`/api/faq/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast.push(t('deleted'), 'success');
      router.refresh();
    } else {
      toast.push(t('deleteFailed'), 'error');
    }
  }

  function fmt(iso: string): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
    }).format(new Date(iso));
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>{t('new')}</Button>
      </div>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
            {t('empty')}
          </div>
        ) : (
          rows.map((r) => {
            const firstLine = r.content.split('\n')[0] ?? '';
            return (
              <div
                key={r.id}
                className="rounded-md border border-gray-200 bg-white p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <p className="font-medium text-gray-900">{firstLine}</p>
                  <p className="shrink-0 text-xs text-gray-500 tabular-nums">
                    {fmt(r.createdAt)}
                  </p>
                </div>
                <p className="whitespace-pre-wrap text-sm text-gray-700">
                  {r.content}
                </p>
                <div className="mt-3 flex justify-end gap-3">
                  <button
                    type="button"
                    className="text-xs text-brand-700 hover:underline"
                    onClick={() => setEditing(r)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-red-600 hover:underline"
                    onClick={() => deleteOne(r.id)}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <FaqFormModal open={creating} onClose={() => setCreating(false)} mode="create" />
      <FaqFormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        mode="edit"
        row={editing}
      />
    </>
  );
}

function FaqFormModal({
  open,
  onClose,
  mode,
  row,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  row?: FaqChunk | null;
}) {
  const t = useTranslations('panel.faq');
  const router = useRouter();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FaqFormValues>({
    resolver: zodResolver(faqSchema),
    defaultValues: {
      content: row?.content ?? '',
    },
  });

  async function onSubmit(values: FaqFormValues) {
    const payload = { content: values.content };
    const res =
      mode === 'create'
        ? await fetcher('/api/faq', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await fetcher(`/api/faq/${row!.id}`, {
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
      className="max-w-2xl"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3" noValidate>
        <div className="space-y-1">
          <Label htmlFor="faq-content">{t('fields.content')}</Label>
          <Textarea
            id="faq-content"
            className="min-h-[180px]"
            placeholder={t('placeholders.content')}
            {...register('content')}
          />
          <p className="text-xs text-gray-500">{t('hints.content')}</p>
          {errors.content ? (
            <p className="text-xs text-red-600">{t('errors.content')}</p>
          ) : null}
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
