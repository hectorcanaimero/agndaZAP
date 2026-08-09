'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout, type AuthMe } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface PanelShellProps {
  locale: string;
  me: AuthMe;
  children: ReactNode;
}

/**
 * Layout con sidebar fijo + header + main. Sobria, priorizando densidad.
 *
 * El sidebar resalta la ruta activa comparando `pathname` con el prefijo del
 * link — así `/panel/servicios/nuevo` sigue mostrando "Servicios" activo.
 */
export function PanelShell({ locale, me, children }: PanelShellProps) {
  const t = useTranslations('panel.nav');
  const pathname = usePathname();

  const items: Array<{ key: string; href: string; label: string }> = [
    { key: 'dashboard', href: `/${locale}/panel/dashboard`, label: t('dashboard') },
    { key: 'agenda', href: `/${locale}/panel/agenda`, label: t('agenda') },
    {
      key: 'conversaciones',
      href: `/${locale}/panel/conversaciones`,
      label: t('conversations'),
    },
    { key: 'servicios', href: `/${locale}/panel/servicios`, label: t('services') },
    {
      key: 'profesionales',
      href: `/${locale}/panel/profesionales`,
      label: t('professionals'),
    },
    { key: 'horarios', href: `/${locale}/panel/horarios`, label: t('businessHours') },
    { key: 'bloqueos', href: `/${locale}/panel/bloqueos`, label: t('timeOff') },
    { key: 'faq', href: `/${locale}/panel/faq`, label: t('faq') },
  ];

  return (
    <div className="flex min-h-screen bg-gray-50 text-gray-900">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
        <div className="border-b border-gray-100 px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            AgendaZap
          </p>
          <p className="mt-1 text-sm font-medium text-gray-900">
            {me.clinic?.name ?? '—'}
          </p>
        </div>
        <nav className="flex-1 px-2 py-3">
          <ul className="space-y-0.5">
            {items.map((item) => {
              const active = pathname?.startsWith(item.href);
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    className={cn(
                      'block rounded-md px-3 py-2 text-sm',
                      active
                        ? 'bg-brand-50 font-medium text-brand-700'
                        : 'text-gray-700 hover:bg-gray-100',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
          <p className="font-medium text-gray-700">{me.name}</p>
          <p className="truncate">{me.email}</p>
          <button
            type="button"
            onClick={() => logout(locale)}
            className="mt-2 text-brand-700 hover:underline"
          >
            {t('logout')}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 md:hidden">
          <p className="text-sm font-semibold">{me.clinic?.name ?? 'AgendaZap'}</p>
          <button
            type="button"
            onClick={() => logout(locale)}
            className="text-sm text-brand-700"
          >
            {t('logout')}
          </button>
        </header>

        {/* Nav horizontal en móvil (sencillo, sin drawer). */}
        <nav className="border-b border-gray-200 bg-white px-2 py-2 md:hidden">
          <ul className="flex gap-2 overflow-x-auto">
            {items.map((item) => {
              const active = pathname?.startsWith(item.href);
              return (
                <li key={item.key} className="shrink-0">
                  <Link
                    href={item.href}
                    className={cn(
                      'rounded-md px-3 py-1 text-sm',
                      active
                        ? 'bg-brand-50 font-medium text-brand-700'
                        : 'text-gray-700 hover:bg-gray-100',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="flex-1 overflow-x-hidden px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
