import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { API_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { InviteAcceptForm } from './InviteAcceptForm';

/**
 * Info del invite tal como llega de `GET /api/public/invitations/:token`.
 * Duplicamos el shape acá (en vez de importar del backend) porque el web
 * bundle no depende del backend.
 */
interface PublicInvitation {
  email: string;
  invitedName: string;
  clinicName: string;
  expiresAt: string; // ISO
}

/**
 * `/[locale]/invite/[token]` — página pública (sin sesión) para activar la
 * cuenta creada por el SUPERADMIN.
 *
 * Server component: hace el fetch inicial contra el backend público. Según
 * el status renderiza:
 *  - 200 → form de "elegí tu contraseña" (client component).
 *  - 404 → estado "enlace inválido".
 *  - 410 → estado "enlace expirado o ya usado".
 *
 * NO usa `fetcher()` (que redirige en 401) — el endpoint es público y no
 * queremos que un 401 accidental te mande al login antes de renderizar el
 * error semántico.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('invite');

  const res = await fetch(
    `${API_URL}/api/public/invitations/${encodeURIComponent(token)}`,
    { cache: 'no-store' },
  );

  if (res.status === 404) {
    return (
      <ErrorState
        locale={locale}
        title={t('invalid.title')}
        description={t('invalid.description')}
        cta={t('invalid.cta')}
      />
    );
  }
  if (res.status === 410) {
    return (
      <ErrorState
        locale={locale}
        title={t('expired.title')}
        description={t('expired.description')}
        cta={t('expired.cta')}
      />
    );
  }
  if (!res.ok) {
    // Cualquier otro error: tratamos como inválido para no exponer detalles
    // del backend a un usuario público.
    return (
      <ErrorState
        locale={locale}
        title={t('invalid.title')}
        description={t('invalid.description')}
        cta={t('invalid.cta')}
      />
    );
  }

  const invitation = (await res.json()) as PublicInvitation;

  return (
    <Shell>
      <div className="mb-6 flex items-center justify-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
          <KeyRound className="h-4 w-4" strokeWidth={2.25} />
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

      <InviteAcceptForm
        locale={locale}
        token={token}
        email={invitation.email}
        invitedName={invitation.invitedName}
        clinicName={invitation.clinicName}
        expiresAt={invitation.expiresAt}
      />
    </Shell>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

/** Layout compartido para form y estados de error. Sin dependencia del auth
 * ni del panel — es una page-level shell mínima. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}

async function ErrorState({
  locale,
  title,
  description,
  cta,
}: {
  locale: string;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <Shell>
      <div className="mb-6 flex items-center justify-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
          <KeyRound className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <span className="text-base font-semibold tracking-tight text-foreground">
          Showly
        </span>
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <Button asChild className="mt-6 w-full">
        <Link href={`/${locale}/login`}>{cta}</Link>
      </Button>
    </Shell>
  );
}
