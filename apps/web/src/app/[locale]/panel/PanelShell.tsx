'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  CalendarDays,
  CalendarX2,
  Clock,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  MessagesSquare,
  Sparkles,
  Users,
  Briefcase,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { logout, type AuthMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { MobileDrawer } from './MobileDrawer';

interface PanelShellProps {
  locale: string;
  me: AuthMe;
  children: ReactNode;
}

export interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavSection {
  key: string;
  label: string;
  items: NavItem[];
}

/**
 * Layout con sidebar fijo + header + main. Sobria, priorizando densidad —
 * pensada para recepcionistas que operan durante horas.
 *
 * El sidebar resalta la ruta activa comparando `pathname` con el prefijo del
 * link — así `/panel/servicios/nuevo` sigue mostrando "Servicios" activo.
 *
 * Nav agrupada en 2 secciones ("Operación" y "Configuración") para reducir
 * carga visual con muchos items. Estado activo con bar izquierda brand +
 * background sutil (contraste ~6:1 sobre white).
 */
export function PanelShell({ locale, me, children }: PanelShellProps) {
  const t = useTranslations('panel.nav');
  const pathname = usePathname();

  const sections: NavSection[] = [
    {
      key: 'operation',
      label: t('sections.operation'),
      items: [
        {
          key: 'dashboard',
          href: `/${locale}/panel/dashboard`,
          label: t('dashboard'),
          icon: LayoutDashboard,
        },
        {
          key: 'agenda',
          href: `/${locale}/panel/agenda`,
          label: t('agenda'),
          icon: CalendarDays,
        },
        {
          key: 'conversaciones',
          href: `/${locale}/panel/conversaciones`,
          label: t('conversations'),
          icon: MessagesSquare,
        },
      ],
    },
    {
      key: 'configuration',
      label: t('sections.configuration'),
      items: [
        {
          key: 'servicios',
          href: `/${locale}/panel/servicios`,
          label: t('services'),
          icon: Briefcase,
        },
        {
          key: 'profesionales',
          href: `/${locale}/panel/profesionales`,
          label: t('professionals'),
          icon: Users,
        },
        {
          key: 'horarios',
          href: `/${locale}/panel/horarios`,
          label: t('businessHours'),
          icon: Clock,
        },
        {
          key: 'bloqueos',
          href: `/${locale}/panel/bloqueos`,
          label: t('timeOff'),
          icon: CalendarX2,
        },
        {
          key: 'faq',
          href: `/${locale}/panel/faq`,
          label: t('faq'),
          icon: HelpCircle,
        },
        {
          key: 'whatsapp',
          href: `/${locale}/panel/config/whatsapp`,
          label: t('whatsapp'),
          icon: MessageCircle,
        },
      ],
    },
  ];

  // Flat list para el drawer mobile (mantiene contrato existente).
  const flatItems = sections.flatMap((s) => s.items);

  const initials = getInitials(me.name);
  const roleLabel = getRoleLabel(t, me.role);
  const fullBleed = isFullBleedRoute(pathname);

  return (
    <div
      className={cn(
        'flex bg-muted/40 text-foreground',
        // En full-bleed, altura fija al viewport para que el hijo `<main>` con
        // `flex-1` pueda propagar `h-full` a la pantalla que ocupa toda la ventana.
        // En modo normal, `min-h-screen` para permitir contenido más largo.
        fullBleed ? 'h-dvh overflow-hidden' : 'min-h-screen',
      )}
    >
      {/* Sidebar desktop */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
        {/* Brand + clinic */}
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm">
            <Sparkles className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <span className="text-base font-semibold tracking-tight">
            AgendaZap
          </span>
        </div>

        <div className="px-5 pb-4">
          <p className="truncate text-sm font-medium text-foreground">
            {me.clinic?.name ?? '—'}
          </p>
          {me.clinic?.slug ? (
            <p className="truncate text-xs text-muted-foreground">
              {me.clinic.slug}
            </p>
          ) : null}
        </div>

        <Separator />

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {sections.map((section, idx) => (
            <div key={section.key} className={cn(idx > 0 && 'mt-6')}>
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
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                          active
                            ? 'bg-brand-50 font-medium text-brand-700'
                            : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {active ? (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1.5 h-[calc(100%-0.75rem)] w-0.5 rounded-r-full bg-brand-600"
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

        {/* User footer con dropdown */}
        <div className="border-t border-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('userMenu')}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {me.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {roleLabel}
                  </p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-0.5">
                  <p className="text-sm font-medium leading-none">{me.name}</p>
                  <p className="truncate text-xs leading-none text-muted-foreground">
                    {me.email || roleLabel}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => logout(locale)}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>{t('logout')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header mobile */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-card/95 px-3 py-2.5 backdrop-blur md:hidden">
          <MobileDrawer
            locale={locale}
            me={me}
            sections={sections}
            flatItems={flatItems}
          />
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2.25} />
            </div>
            <p className="min-w-0 truncate text-sm font-semibold">
              {me.clinic?.name ?? 'AgendaZap'}
            </p>
          </div>
          {/* Avatar iniciales — abre logout via dropdown también en mobile */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('userMenu')}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-sm font-semibold text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100">
                  {initials}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-0.5">
                  <p className="text-sm font-medium leading-none">{me.name}</p>
                  <p className="truncate text-xs leading-none text-muted-foreground">
                    {me.email || roleLabel}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => logout(locale)}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>{t('logout')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/*
          Rutas full-bleed (ej. /panel/conversaciones): la pantalla necesita
          ocupar todo el viewport, sin padding ni max-width del shell. En vez de
          duplicar cascadas de layouts, la shell detecta la ruta y omite la
          jaula. Cualquier otra ruta mantiene el contenedor con `max-w-[1600px]`.
        */}
        {isFullBleedRoute(pathname) ? (
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        ) : (
          <main className="flex-1 overflow-x-hidden px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-[1600px]">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}

/**
 * Rutas que necesitan ocupar el viewport entero sin la jaula del contenedor
 * (padding + max-width). Hoy: bandeja de conversaciones. Agregar acá cuando
 * aparezca otra pantalla que lo pida.
 */
const FULL_BLEED_SEGMENTS = ['/panel/conversaciones'] as const;

function isFullBleedRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return FULL_BLEED_SEGMENTS.some((seg) => pathname.includes(seg));
}

/** Toma iniciales — hasta 2 letras — para el avatar. */
function getInitials(name: string): string {
  if (!name || name === '—') return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Traduce el rol del usuario si tenemos label en i18n; si no, cae al valor raw.
 * Evita romper si el backend agrega roles nuevos que aún no están en i18n.
 */
function getRoleLabel(
  t: ReturnType<typeof useTranslations<'panel.nav'>>,
  role: string | undefined,
): string {
  if (!role) return '';
  try {
    return t(`roles.${role}` as never);
  } catch {
    return role;
  }
}
