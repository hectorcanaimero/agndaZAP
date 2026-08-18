'use client';

import { AlertTriangle, LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { endImpersonation } from '@/lib/auth';
import { Button } from '@/components/ui/button';

interface ImpersonationBannerProps {
  locale: string;
  /** Nombre de la clínica que está siendo impersonada (para mostrar en el banner). */
  clinicName: string;
}

/**
 * Barra amber persistente que se renderiza sobre el `PanelShell` cuando el
 * usuario activo es un SUPERADMIN operando bajo un JWT impersonado
 * (`session.impersonatedBy` presente). Su función es doble:
 *
 * 1. Recordar visualmente al super que NO está en su propia cuenta — todo lo
 *    que haga queda registrado en `AdminAudit` bajo su userId, pero afecta
 *    datos de la clínica impersonada. Sin esta señal es fácil confundir el
 *    contexto y actuar por error sobre datos de un tercero.
 *
 * 2. Ofrecer el atajo "Volver al Admin" que restaura la sesión original del
 *    super (leyendo el backup en `showly_admin_token`) y redirige al área
 *    admin sin pasar por login.
 */
export function ImpersonationBanner({
  locale,
  clinicName,
}: ImpersonationBannerProps) {
  const t = useTranslations('impersonation.banner');

  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-amber-300/70 bg-amber-100 px-4 py-2 text-amber-900"
    >
      <AlertTriangle
        className="h-4 w-4 shrink-0"
        strokeWidth={2.25}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{t('title')}</span>
        <span className="mx-1.5 opacity-60">·</span>
        <span className="truncate">
          {t('currentClinic', { name: clinicName })}
        </span>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => endImpersonation(locale)}
        className="shrink-0 gap-1.5 border-amber-400 bg-white text-amber-900 hover:bg-amber-50 hover:text-amber-900"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{t('backToAdmin')}</span>
      </Button>
    </div>
  );
}
