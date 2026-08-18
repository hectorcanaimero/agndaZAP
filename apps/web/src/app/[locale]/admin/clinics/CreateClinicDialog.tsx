'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  CreateClinicPayload,
  CreateClinicResponse,
} from '@/lib/admin';
import { apiMutation, ApiError } from '@/lib/query-fn';

interface Props {
  locale: string;
}

/**
 * Validación matcheando `CreateClinicDto` del backend:
 * - `slug` restringido al mismo regex del `SlugValidationPipe`.
 * - `wahaSession` es libre (validado unique en DB, error 409 lo maneja el
 *   mutation).
 * - NO hay password: el backend genera random y manda invitación por email.
 */
const createClinicSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'slug'),
  wahaSession: z.string().min(1).max(120),
  timezone: z.string().max(60).optional().or(z.literal('')),
  locale: z.enum(['es', 'pt']).optional(),
  address: z.string().max(255).optional().or(z.literal('')),
  admin: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
  }),
});

type FormValues = z.infer<typeof createClinicSchema>;

/**
 * Dialog + form para el `POST /admin/clinics`. El backend:
 *  1) Crea clínica + primer CLINIC_ADMIN en una transacción.
 *  2) Genera una Invitation con TTL 7 días.
 *  3) Envía email al admin con el link de activación.
 *
 * Fallback si el email no se pudo enviar (`invitation.emailSent === false`):
 * mostramos un segundo dialog con el `invitation.url` y un botón "Copiar",
 * para que el super lo pase al cliente por WhatsApp/chat.
 *
 * Al éxito con email enviado, invalidamos el listado y navegamos al detalle.
 */
export function CreateClinicDialog({ locale }: Props) {
  const t = useTranslations('admin.clinics.createDialog');
  const [open, setOpen] = useState(false);
  const [fallbackLink, setFallbackLink] = useState<{
    url: string;
    email: string;
    clinicId: string;
  } | null>(null);
  const router = useRouter();
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(createClinicSchema),
    defaultValues: {
      name: '',
      slug: '',
      wahaSession: '',
      timezone: 'America/Caracas',
      locale: locale === 'pt' ? 'pt' : 'es',
      address: '',
      admin: { name: '', email: '' },
    },
  });

  const mutation = useMutation({
    mutationFn: (payload: CreateClinicPayload) =>
      apiMutation<CreateClinicResponse, CreateClinicPayload>(
        '/api/admin/clinics',
        'POST',
        payload,
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin', 'clinics'] });
      setOpen(false);
      reset();

      if (data.invitation.emailSent) {
        // Camino feliz: email enviado. Toast + navegar al detalle.
        toast.success(t('success', { email: data.admin.email }));
        router.push(`/${locale}/admin/clinics/${data.id}`);
        return;
      }

      // Fallback: email no salió. Abrimos dialog con el link para copiar.
      // El super navega al detalle cuando cierra el dialog.
      toast.warning(t('successMailFail'));
      setFallbackLink({
        url: data.invitation.url,
        email: data.admin.email,
        clinicId: data.id,
      });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const msg = err.message.toLowerCase();
        if (msg.includes('slug')) {
          setError('slug', { message: t('errors.slugTaken') });
          return;
        }
        if (msg.includes('waha')) {
          setError('wahaSession', { message: t('errors.wahaSessionTaken') });
          return;
        }
      }
      toast.error(t('errors.generic'));
    },
  });

  function onSubmit(values: FormValues) {
    const payload: CreateClinicPayload = {
      name: values.name.trim(),
      slug: values.slug.trim(),
      wahaSession: values.wahaSession.trim(),
      ...(values.timezone ? { timezone: values.timezone } : {}),
      ...(values.locale ? { locale: values.locale } : {}),
      ...(values.address ? { address: values.address.trim() } : {}),
      admin: {
        name: values.admin.name.trim(),
        email: values.admin.email.trim().toLowerCase(),
      },
    };
    mutation.mutate(payload);
  }

  const busy = isSubmitting || mutation.isPending;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('trigger')}
          </Button>
        </DialogTrigger>

        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          <form
            onSubmit={handleSubmit(onSubmit)}
            className="space-y-5"
            noValidate
          >
            {/* Sección clínica */}
            <fieldset className="space-y-3">
              <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('sections.clinic')}
              </legend>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field
                  id="name"
                  label={t('labels.name')}
                  error={errors.name ? t('errors.required') : undefined}
                >
                  <Input
                    id="name"
                    autoComplete="off"
                    disabled={busy}
                    {...register('name')}
                  />
                </Field>

                <Field
                  id="slug"
                  label={t('labels.slug')}
                  hint={t('labels.slugHint')}
                  error={
                    errors.slug
                      ? errors.slug.message === 'slug'
                        ? t('errors.slugFormat')
                        : errors.slug.message ?? t('errors.required')
                      : undefined
                  }
                >
                  <Input
                    id="slug"
                    autoComplete="off"
                    disabled={busy}
                    className="font-mono"
                    {...register('slug')}
                  />
                </Field>

                <Field
                  id="wahaSession"
                  label={t('labels.wahaSession')}
                  hint={t('labels.wahaSessionHint')}
                  error={
                    errors.wahaSession
                      ? errors.wahaSession.message ?? t('errors.required')
                      : undefined
                  }
                >
                  <Input
                    id="wahaSession"
                    autoComplete="off"
                    disabled={busy}
                    className="font-mono"
                    {...register('wahaSession')}
                  />
                </Field>

                <Field id="timezone" label={t('labels.timezone')}>
                  <Input
                    id="timezone"
                    autoComplete="off"
                    disabled={busy}
                    {...register('timezone')}
                  />
                </Field>

                <Field id="locale" label={t('labels.locale')}>
                  <select
                    id="locale"
                    disabled={busy}
                    {...register('locale')}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="es">es</option>
                    <option value="pt">pt</option>
                  </select>
                </Field>

                <Field id="address" label={t('labels.address')} full>
                  <Input
                    id="address"
                    autoComplete="off"
                    disabled={busy}
                    {...register('address')}
                  />
                </Field>
              </div>
            </fieldset>

            {/* Sección admin */}
            <fieldset className="space-y-3">
              <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('sections.admin')}
              </legend>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field
                  id="admin.name"
                  label={t('labels.adminName')}
                  error={errors.admin?.name ? t('errors.required') : undefined}
                >
                  <Input
                    id="admin.name"
                    autoComplete="off"
                    disabled={busy}
                    {...register('admin.name')}
                  />
                </Field>

                <Field
                  id="admin.email"
                  label={t('labels.adminEmail')}
                  error={
                    errors.admin?.email ? t('errors.emailInvalid') : undefined
                  }
                >
                  <Input
                    id="admin.email"
                    type="email"
                    autoComplete="off"
                    disabled={busy}
                    {...register('admin.email')}
                  />
                </Field>
              </div>
            </fieldset>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '…' : t('submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {fallbackLink ? (
        <FallbackLinkDialog
          url={fallbackLink.url}
          email={fallbackLink.email}
          onClose={() => {
            const cid = fallbackLink.clinicId;
            setFallbackLink(null);
            router.push(`/${locale}/admin/clinics/${cid}`);
          }}
        />
      ) : null}
    </>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

function Field({
  id,
  label,
  hint,
  error,
  full = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={full ? 'flex flex-col gap-1.5 md:col-span-2' : 'flex flex-col gap-1.5'}>
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      {children}
      {hint && !error ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Dialog secundario que aparece cuando el email de invitación falló. Muestra
 * el link en un input de solo lectura + botón "Copiar" (usa clipboard API).
 */
function FallbackLinkDialog({
  url,
  email,
  onClose,
}: {
  url: string;
  email: string;
  onClose: () => void;
}) {
  const t = useTranslations('admin.clinics.createDialog.linkDialog');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: seleccionar el input para copiar manual.
      const input = document.getElementById(
        'fallback-link-input',
      ) as HTMLInputElement | null;
      input?.select();
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { email })}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            id="fallback-link-input"
            readOnly
            value={url}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            variant={copied ? 'default' : 'outline'}
            size="sm"
            onClick={copy}
            className="shrink-0 gap-1.5"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                {t('copied')}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                {t('copy')}
              </>
            )}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
