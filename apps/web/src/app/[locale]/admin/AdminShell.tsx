'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  BarChart3,
  Building2,
  ClipboardList,
  LogOut,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Logo } from '@/components/landing/Logo';
import { logout } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface AdminShellProps {
  locale: string;
  /** Email del SUPERADMIN logueado (para mostrarlo en el header). */
  email: string;
  children: ReactNode;
}

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Shell del Área SaaS Admin.
 *
 * Layout análogo a PanelShell pero más compacto — sin secciones agrupadas,
 * ya que el área de admin tiene pocos items y son todos de naturaleza similar
 * (operación cross-tenant). Header fijo indica claramente "Área SaaS Admin"
 * y el email del super logueado para que no haya confusión de contexto.
 *
 * La barra lateral usa los colores corporativos de Showly (navy #0F2A4A y teal
 * #28D9B9) para diferenciarse del panel de clínica, que usa el verde WhatsApp
 * (`brand-600`). El pill "Admin" al lado del wordmark deja claro el contexto.
 * La señal amber de "peligro cross-tenant" se reserva ahora para el
 * `ImpersonationBanner`, que aparece solo durante impersonation activa.
 */
export function AdminShell({ locale, email, children }: AdminShellProps) {
  const t = useTranslations('admin');
  const pathname = usePathname();

  const navItems: NavItem[] = [
    {
      key: 'dashboard',
      href: `/${locale}/admin/dashboard`,
      label: t('nav.dashboard'),
      icon: BarChart3,
    },
    {
      key: 'clinics',
      href: `/${locale}/admin/clinics`,
      label: t('nav.clinics'),
      icon: Building2,
    },
    {
      key: 'leads',
      href: `/${locale}/admin/leads`,
      label: t('nav.leads'),
      icon: UserPlus,
    },
    {
      key: 'audit',
      href: `/${locale}/admin/audit`,
      label: t('nav.audit'),
      icon: ClipboardList,
    },
  ];

  return (
    <div className="flex h-dvh overflow-hidden bg-muted/40 text-foreground">
      {/* Sidebar desktop */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
        {/* Marca (wordmark real) + pill de contexto Admin */}
        <div className="flex items-center gap-2 px-5 pb-3 pt-5">
          <Logo variant="full" className="h-6 w-auto shrink-0" />
          <span className="rounded-md bg-brand-navy/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-navy">
            Admin
          </span>
        </div>

        <Separator />

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-0.5">
            {navItems.map((item) => {
              const active = pathname?.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-brand-navy/5 font-medium text-brand-navy'
                        : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1.5 h-[calc(100%-0.75rem)] w-0.5 rounded-r-full bg-brand-teal"
                      />
                    ) : null}
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active
                          ? 'text-brand-navy'
                          : 'text-muted-foreground group-hover:text-foreground',
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <Separator className="my-4" />

          {/* Salir del Admin */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-3 px-3 text-muted-foreground hover:text-destructive"
            onClick={() => logout(locale)}
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t('nav.logout')}</span>
          </Button>
        </nav>

        {/* Footer: email del SUPERADMIN */}
        <div className="border-t border-border px-5 py-3">
          <p className="truncate text-[11px] text-muted-foreground" title={email}>
            {email}
          </p>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header: siempre visible, desktop + mobile */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
          {/* Mobile: wordmark + pill Admin */}
          <Logo variant="full" className="h-6 w-auto shrink-0 md:hidden" />
          <span className="rounded-md bg-brand-navy/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-navy md:hidden">
            Admin
          </span>
          <div className="hidden min-w-0 flex-1 md:block">
            <p className="text-sm font-semibold text-brand-navy">
              {t('header.title')}
            </p>
            <p className="hidden truncate text-[11px] text-muted-foreground md:block">
              {email}
            </p>
          </div>
          <div className="flex-1 md:hidden" />
          {/* Botón salir — visible en mobile */}
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-2 text-muted-foreground hover:text-destructive md:hidden"
            onClick={() => logout(locale)}
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t('nav.logout')}</span>
          </Button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
