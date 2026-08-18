'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, KeyRound, LogIn } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { API_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  locale: string;
  token: string;
  email: string;
  invitedName: string;
  clinicName: string;
  expiresAt: string; // ISO
}

const acceptSchema = z
  .object({
    password: z.string().min(8),
    passwordConfirm: z.string().min(1),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    path: ['passwordConfirm'],
    message: 'mismatch',
  });

type FormValues = z.infer<typeof acceptSchema>;

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'pt' ? 'pt-BR' : 'es-419', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}

/**
 * Client form para setear la contraseña y consumir la invitación.
 *
 * NO usa el `fetcher()` del panel — el endpoint es público y no queremos
 * que un 401 accidental redirija al login antes de mostrar el error. Uso
 * `fetch` nativo directo contra `API_URL`.
 *
 * Al éxito muestra un estado "cuenta activada" con botón para ir al login,
 * en vez de auto-redirigir. Motivo: el usuario acaba de setear una
 * contraseña y probablemente quiera confirmar visualmente que funcionó
 * antes de perderla de vista.
 */
export function InviteAcceptForm({
  locale,
  token,
  email,
  invitedName,
  clinicName,
  expiresAt,
}: Props) {
  const t = useTranslations('invite');
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { password: '', passwordConfirm: '' },
  });

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await fetch(
        `${API_URL}/api/public/invitations/${encodeURIComponent(token)}/accept`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plainPassword: values.password }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setDone(true);
      toast.success(t('success'));
    },
    onError: () => {
      const msg = t('errors.generic');
      setSubmitError(msg);
      toast.error(msg);
    },
  });

  const busy = isSubmitting || mutation.isPending;

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-700">
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
        </div>
        <p className="text-sm text-foreground">{t('success')}</p>
        <Button asChild className="w-full gap-2">
          <a href={`/${locale}/login`}>
            <LogIn className="h-4 w-4" aria-hidden="true" />
            {t('goToLogin')}
          </a>
        </Button>
      </div>
    );
  }

  function onSubmit(values: FormValues) {
    setSubmitError(null);
    mutation.mutate(values);
  }

  return (
    <>
      <div className="mb-6 rounded-md border border-border bg-muted/40 p-3 text-sm">
        <p className="font-medium text-foreground">
          {t('greeting', { name: invitedName })}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t('context', { clinic: clinicName })}
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t('expires', { date: formatDate(expiresAt, locale) })}
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-sm font-medium">
            {t('labels.email')}
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            readOnly
            disabled
            className="bg-muted/40"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-sm font-medium">
            {t('labels.password')}
          </Label>
          <div className="relative">
            <KeyRound
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              disabled={busy}
              className="pl-9"
              aria-invalid={errors.password ? 'true' : 'false'}
              {...register('password')}
            />
          </div>
          {errors.password ? (
            <p className="text-xs text-destructive" role="alert">
              {t('errors.passwordMin')}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t('hints.passwordMin')}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="passwordConfirm" className="text-sm font-medium">
            {t('labels.passwordConfirm')}
          </Label>
          <div className="relative">
            <KeyRound
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="passwordConfirm"
              type="password"
              autoComplete="new-password"
              disabled={busy}
              className="pl-9"
              aria-invalid={errors.passwordConfirm ? 'true' : 'false'}
              {...register('passwordConfirm')}
            />
          </div>
          {errors.passwordConfirm ? (
            <p className="text-xs text-destructive" role="alert">
              {errors.passwordConfirm.message === 'mismatch'
                ? t('errors.passwordMismatch')
                : t('errors.passwordMin')}
            </p>
          ) : null}
        </div>

        {submitError ? (
          <div
            className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span className="leading-snug">{submitError}</span>
          </div>
        ) : null}

        <Button type="submit" disabled={busy} className="h-10 w-full">
          {busy ? t('submitting') : t('submit')}
        </Button>
      </form>
    </>
  );
}
