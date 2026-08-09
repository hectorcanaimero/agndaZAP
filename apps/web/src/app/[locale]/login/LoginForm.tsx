'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login } from '@/lib/auth';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type LoginFormValues = z.infer<typeof loginSchema>;

interface LoginFormProps {
  locale: string;
}

/**
 * Client component del login. Usa `window.location.assign` en éxito para
 * forzar un full reload — así el middleware server-side re-ejecuta el chequeo
 * del cookie y no hay condición de carrera con el router client.
 */
export function LoginForm({ locale }: LoginFormProps) {
  const t = useTranslations('login');
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const [submitError, setSubmitError] = useState<string | null>(null);

  async function onSubmit(values: LoginFormValues) {
    setSubmitError(null);
    const result = await login(values.email, values.password);

    if (result.ok) {
      // Full reload para que el middleware corra con el cookie ya seteado.
      const target =
        nextPath && nextPath.startsWith(`/${locale}/panel`)
          ? nextPath
          : `/${locale}/panel/dashboard`;
      window.location.assign(target);
      return;
    }

    if (result.status === 401) {
      setSubmitError(t('errors.invalidCredentials'));
      return;
    }
    if (result.status === 429) {
      setSubmitError(t('errors.tooManyAttempts'));
      return;
    }
    setSubmitError(t('errors.generic'));
  }

  return (
    <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-6 text-center">
        <h1 className="text-xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
      </div>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">{t('labels.email')}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder={t('placeholders.email')}
            {...register('email')}
          />
          {errors.email ? (
            <p className="text-sm text-red-600">{t('errors.email')}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">{t('labels.password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...register('password')}
          />
          {errors.password ? (
            <p className="text-sm text-red-600">{t('errors.password')}</p>
          ) : null}
        </div>

        {submitError ? (
          <div
            className="rounded-md bg-red-50 p-3 text-sm text-red-800"
            role="alert"
          >
            {submitError}
          </div>
        ) : null}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? t('submitting') : t('submit')}
        </Button>
      </form>
    </div>
  );
}
