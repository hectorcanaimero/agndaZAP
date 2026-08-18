'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AlertCircle, KeyRound, LogIn, Mail, Sparkles, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login, type LoginResponse } from '@/lib/auth';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type LoginFormValues = z.infer<typeof loginSchema>;

interface LoginFormProps {
  locale: string;
}

/**
 * Client component del login.
 *
 * Usa `useMutation` para el POST de login — el `login()` helper mantiene su
 * shape de LoginResponse (discriminated union) para no perder el status HTTP.
 * En éxito hacemos `window.location.assign` para full reload — el middleware
 * server-side re-ejecuta el chequeo del cookie y evita condición de carrera
 * con el router client.
 *
 * Manejo de errores: 401 → credenciales inválidas, 429 → rate limit, resto →
 * genérico. Tanto el mensaje en el banner `role="alert"` como el toast Sonner
 * cumplen con lo pedido en el spec de rediseño F6.
 */
export function LoginForm({ locale }: LoginFormProps) {
  const t = useTranslations('login');
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next');

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const [submitError, setSubmitError] = useState<string | null>(null);

  const loginMutation = useMutation<
    LoginResponse,
    Error,
    { email: string; password: string }
  >({
    mutationFn: ({ email, password }) => login(email, password),
    onSuccess: (result) => {
      if (result.ok) {
        // Full reload para que el middleware corra con el cookie ya seteado.
        const target =
          nextPath && nextPath.startsWith(`/${locale}/panel`)
            ? nextPath
            : `/${locale}/panel/dashboard`;
        window.location.assign(target);
        return;
      }

      // El helper `login` no tira Error en fallos — devuelve `{ok:false,status}`.
      // Mapeamos status → copy específico + toast.
      if (result.status === 401) {
        const msg = t('errors.invalidCredentials');
        setSubmitError(msg);
        toast.error(msg);
        return;
      }
      if (result.status === 429) {
        const msg = t('errors.tooManyAttempts');
        setSubmitError(msg);
        toast.error(msg);
        return;
      }
      const msg = t('errors.generic');
      setSubmitError(msg);
      toast.error(msg);
    },
    onError: () => {
      const msg = t('errors.generic');
      setSubmitError(msg);
      toast.error(msg);
    },
  });

  async function onSubmit(values: LoginFormValues) {
    setSubmitError(null);
    loginMutation.mutate({ email: values.email, password: values.password });
  }

  const submitting = isSubmitting || loginMutation.isPending;

  return (
    <div className="w-full max-w-sm">
      {/* Brand mark — solo mobile (en desktop lo tiene el brand panel) */}
      <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
          <Sparkles className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <span className="text-base font-semibold tracking-tight text-foreground">
          Showly
        </span>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-sm font-medium">
            {t('labels.email')}
          </Label>
          <div className="relative">
            <Mail
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder={t('placeholders.email')}
              aria-invalid={errors.email ? 'true' : 'false'}
              className="pl-9"
              {...register('email')}
            />
          </div>
          {errors.email ? (
            <p
              id="email-error"
              className="text-sm text-destructive"
              role="alert"
            >
              {t('errors.email')}
            </p>
          ) : null}
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
              autoComplete="current-password"
              aria-invalid={errors.password ? 'true' : 'false'}
              className="pl-9"
              {...register('password')}
            />
          </div>
          {errors.password ? (
            <p
              id="password-error"
              className="text-sm text-destructive"
              role="alert"
            >
              {t('errors.password')}
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

        <Button
          type="submit"
          disabled={submitting}
          className="h-10 w-full gap-2 font-medium"
        >
          {submitting ? (
            t('submitting')
          ) : (
            <>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {t('submit')}
            </>
          )}
        </Button>
      </form>

      <p className="mt-8 border-t border-border pt-6 text-center text-xs text-muted-foreground">
        {t('recovery.hint')}
      </p>

      <DevCredentials
        onPick={(email, password) => {
          setValue('email', email, { shouldValidate: true });
          setValue('password', password, { shouldValidate: true });
        }}
      />
    </div>
  );
}

/* ─────────────────────────── Dev-only credentials picker ─────────────────────────── */

/**
 * Panel de credenciales de dev inyectadas por `prisma/seed.ts`. Solo se
 * renderiza cuando `NODE_ENV !== 'production'` — Next.js elimina el bloque
 * completo del bundle en builds productivos vía dead-code elimination sobre
 * `process.env.NODE_ENV`.
 *
 * Click en una fila autocompleta email + password del formulario para que
 * el operador no tenga que memorizar los pares del seed. Diseño amber
 * intencional para señalar "esto no es prod".
 */
const DEV_CREDENTIALS: Array<{
  role: 'SUPERADMIN' | 'CLINIC_ADMIN' | 'CLINIC_ADMIN_SUSPENDED';
  email: string;
  password: string;
  note: string;
}> = [
  {
    role: 'SUPERADMIN',
    email: 'super@showly.dev',
    password: 'super1234',
    note: 'Área /admin (cross-tenant)',
  },
  {
    role: 'CLINIC_ADMIN',
    email: 'admin@demo.dev',
    password: 'demo1234',
    note: 'Clínica demo activa',
  },
  {
    role: 'CLINIC_ADMIN_SUSPENDED',
    email: 'admin@demo-2.dev',
    password: 'demo1234',
    note: 'Clínica suspendida — login bloqueado',
  },
];

function DevCredentials({
  onPick,
}: {
  onPick: (email: string, password: string) => void;
}) {
  if (process.env.NODE_ENV === 'production') return null;

  return (
    <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-800">
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Dev — click para autocompletar</span>
      </div>
      <ul className="flex flex-col gap-1">
        {DEV_CREDENTIALS.map((c) => (
          <li key={c.email}>
            <button
              type="button"
              onClick={() => onPick(c.email, c.password)}
              className="flex w-full items-start gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <span className="mt-0.5 shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                {c.role}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-amber-900">
                  {c.email} · {c.password}
                </span>
                <span className="block truncate text-[11px] text-amber-700">
                  {c.note}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
