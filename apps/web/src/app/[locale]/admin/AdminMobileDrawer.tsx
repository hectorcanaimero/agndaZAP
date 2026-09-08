'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { LogOut, Menu } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { Logo } from '@/components/landing/Logo';
import { logout } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { AdminNavItem } from './AdminShell';

interface AdminMobileDrawerProps {
  locale: string;
  email: string;
  navItems: AdminNavItem[];
}

const ADMIN_DRAWER_ID = 'admin-mobile-navigation-drawer';

/**
 * Drawer mobile del área SaaS Admin.
 *
 * El sidebar admin se oculta en <md; sin este drawer, un superadmin mobile
 * quedaba encerrado en la pantalla actual. `Sheet` (Radix Dialog) aporta
 * focus trap, Escape, click exterior y retorno de foco al trigger. El trigger
 * expone `aria-expanded` explícito porque es parte del contrato responsive/a11y
 * auditado en F1.5.T2.
 */
export function AdminMobileDrawer({
  locale,
  email,
  navItems,
}: AdminMobileDrawerProps) {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={open ? t('closeMenu') : t('openMenu')}
          aria-controls={ADMIN_DRAWER_ID}
          aria-expanded={open}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      </SheetTrigger>

      <SheetContent
        id={ADMIN_DRAWER_ID}
        side="left"
        className="flex w-72 max-w-[85vw] flex-col gap-0 p-0 sm:max-w-[85vw]"
      >
        <SheetHeader className="space-y-3 border-b border-border px-5 pb-4 pt-5 text-left">
          <div className="flex items-center gap-2.5">
            <Logo variant="mark" className="h-8 w-8 shrink-0" />
            <span className="text-base font-semibold tracking-tight">
              Showly
            </span>
            <span className="rounded-md bg-brand-navy/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-navy">
              Admin
            </span>
          </div>
          <SheetTitle className="truncate text-sm font-medium text-foreground">
            {email}
          </SheetTitle>
        </SheetHeader>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-0.5">
            {navItems.map((item) => {
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
                        ? 'bg-brand-navy/5 font-medium text-brand-navy'
                        : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-2 h-[calc(100%-1rem)] w-0.5 rounded-r-full bg-brand-teal"
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
        </nav>

        <Separator />

        <div className="p-3">
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
