'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { LogOut, Menu, Sparkles } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { logout, type AuthMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { NavItem, NavSection } from './PanelShell';

/**
 * Item plano — mantiene compat con cualquier consumidor que pase items
 * sin agrupar (por ahora, el propio PanelShell pasa `flatItems`).
 */
export interface DrawerNavItem {
  key: string;
  href: string;
  label: string;
}

interface MobileDrawerProps {
  locale: string;
  me: AuthMe;
  /** Nav agrupada por secciones — misma que sidebar desktop. */
  sections: NavSection[];
  /** Lista plana (para hidratar o fallback). No se usa si `sections` existe. */
  flatItems?: NavItem[] | DrawerNavItem[];
}

/**
 * Drawer de navegación mobile (<md) para el panel.
 *
 * F2 lo migró a shadcn `Sheet` (Radix Dialog side="left"). Radix nos da:
 *  - Focus trap Tab / Shift+Tab.
 *  - Escape para cerrar.
 *  - Click en backdrop cierra.
 *  - Foco vuelve al trigger al cerrar.
 *  - `role="dialog" aria-modal="true"` + aria-labelledby por el `SheetTitle`.
 *
 * F3 alinea el look con el sidebar desktop: iconos lucide, secciones
 * ("Operación" / "Configuración"), brand mark, footer con logout.
 *
 * Preservamos:
 *  - Touch targets ≥44×44 (WCAG 2.5.5) en el hamburger y los links.
 *  - Cierra el drawer tras navegar (onClick en cada Link).
 *  - Copy i18n via `panel.nav.*`.
 */
export function MobileDrawer({
  locale,
  me,
  sections,
}: MobileDrawerProps) {
  const t = useTranslations('panel.nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={open ? t('closeMenu') : t('openMenu')}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      </SheetTrigger>

      <SheetContent
        side="left"
        className="flex w-72 max-w-[85vw] flex-col gap-0 p-0 sm:max-w-[85vw]"
      >
        <SheetHeader className="space-y-3 border-b border-border px-5 pb-4 pt-5 text-left">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm">
              <Sparkles className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <span className="text-base font-semibold tracking-tight">
              Showly
            </span>
          </div>
          <div>
            <SheetTitle className="text-sm font-medium text-foreground">
              {me.clinic?.name ?? '—'}
            </SheetTitle>
            {me.clinic?.slug ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {me.clinic.slug}
              </p>
            ) : null}
          </div>
        </SheetHeader>

        {/* Nav agrupada */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {sections.map((section, idx) => (
            <div key={section.key} className={cn(idx > 0 && 'mt-5')}>
              <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname?.startsWith(item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                          active
                            ? 'bg-brand-50 font-medium text-brand-700'
                            : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {active ? (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-2 h-[calc(100%-1rem)] w-0.5 rounded-r-full bg-brand-600"
                          />
                        ) : null}
                        <Icon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            active
                              ? 'text-brand-600'
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
            </div>
          ))}
        </nav>

        <Separator />

        {/* Footer con user + logout */}
        <div className="p-3">
          <div className="mb-3 flex items-center gap-3 px-2 py-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
              {getInitials(me.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {me.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {me.email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              logout(locale);
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t('logout')}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function getInitials(name: string): string {
  if (!name || name === '—') return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
