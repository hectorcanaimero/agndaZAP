'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  CalendarDays,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Settings,
  Star,
  UserRound,
  Users,
  Briefcase,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/landing/Logo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { logout, type AuthMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { ImpersonationBanner } from './ImpersonationBanner';
import { MobileDrawer } from './MobileDrawer';

const SIDEBAR_STORAGE_KEY = 'showly:sidebar:collapsed';

interface PanelShellProps {
  locale: string;
  me: AuthMe;
  /**
   * Cuando está presente indica que la sesión activa es un SUPERADMIN
   * operando bajo un JWT impersonado. Se renderiza el `ImpersonationBanner`
   * arriba del layout. El valor viene del claim `impersonatedBy` del JWT
   * decodificado por el layout server component.
   */
  isImpersonating?: boolean;
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
export function PanelShell({
  locale,
  me,
  isImpersonating = false,
  children,
}: PanelShellProps) {
  const t = useTranslations('panel.nav');
  const pathname = usePathname();

  // Colapso persistido en localStorage. Iniciamos en `false` (expandido) en
  // SSR + primer render cliente para evitar hydration mismatch — el valor real
  // se rehidrata en el efecto de abajo. El flash resultante es de 1 frame y
  // solo ocurre en la primera visita post-toggle; el trade-off es aceptable
  // frente a la complejidad de leer el estado en el server (cookie) o inyectar
  // un script pre-hidratación en <head>.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === 'true') setCollapsed(true);
    } catch {
      // localStorage bloqueado (modo privado, storage lleno, cookies off).
      // Ignoramos — el sidebar simplemente no persiste entre sesiones.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? 'true' : 'false');
      } catch {
        // noop — ver comentario en el efecto de arriba.
      }
      return next;
    });
  };

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
        {
          key: 'pacientes',
          href: `/${locale}/panel/pacientes`,
          label: t('patients'),
          icon: UserRound,
        },
        // Leads: se movió a `/[locale]/admin/leads` porque son CROSS-TENANT
        // (no tienen `clinicId`) y el endpoint del backend es SUPERADMIN-only.
        // Un CLINIC_ADMIN recibía 403 al abrirlo desde acá.
        {
          key: 'feedback',
          href: `/${locale}/panel/feedback`,
          label: t('feedback'),
          icon: Star,
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
        // WhatsApp vive ahora como tab dentro de /panel/ajustes.
        // `/panel/config/whatsapp` sigue funcionando (redirect a
        // /panel/ajustes?tab=whatsapp) — se removió del nav pero no de las
        // rutas.
        {
          key: 'ajustes',
          href: `/${locale}/panel/ajustes`,
          label: t('settings'),
          icon: Settings,
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
    <div className="flex h-dvh flex-col overflow-hidden bg-muted/40 text-foreground">
      {isImpersonating && me.clinic ? (
        <ImpersonationBanner locale={locale} clinicName={me.clinic.name} />
      ) : null}
      <div
        className={cn(
          // Altura restante: el `<main>` interno es el único scroller. Esto le
          // permite a rutas tipo bandeja/split-view usar `h-full` y darle
          // scroll independiente a cada columna, mientras que las rutas
          // "documento" (agenda, tablas, forms) siguen scrolleando dentro del
          // main con el padding y max-width intactos.
          // `relative` habilita el botón circular de toggle (hermano del
          // aside) que flota sobre el borde derecho del sidebar. Sin este
          // relative, el botón se anclaría al viewport.
          'relative flex min-h-0 flex-1 overflow-hidden',
        )}
      >
      {/* Sidebar desktop */}
      <TooltipProvider delayDuration={200} skipDelayDuration={500}>
        <aside
          data-collapsed={collapsed ? 'true' : 'false'}
          className={cn(
            'hidden shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out md:flex',
            collapsed ? 'w-[68px]' : 'w-64',
          )}
        >
          {/* Header: brand. Toggle vive fuera del aside como botón circular
              flotante en el borde derecho (ver más abajo). Cuando colapsado,
              el wordmark se sustituye por el mark centrado. */}
          <div
            className={cn(
              'flex px-3 pb-3 pt-4',
              collapsed
                ? 'flex-col items-center gap-2'
                : 'items-center gap-2.5 px-5',
            )}
          >
            {collapsed ? (
              <Logo variant="mark" className="h-8 w-8 shrink-0" />
            ) : (
              <Logo variant="full" className="h-6 w-auto shrink-0" />
            )}
          </div>

          {/* Clinic info: solo cuando expandido. En colapsado no cabe y el
              tooltip del avatar cubre la identidad de la clínica implícitamente. */}
          {!collapsed && (
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
          )}

          <Separator />

          {/* Nav */}
          <nav
            className={cn(
              'flex-1 overflow-y-auto py-4',
              collapsed ? 'px-2' : 'px-3',
            )}
          >
            {sections.map((section, idx) => (
              <div
                key={section.key}
                className={cn(idx > 0 && (collapsed ? 'mt-3' : 'mt-6'))}
              >
                {collapsed ? (
                  // En colapsado, un separator sutil entre secciones reemplaza
                  // el label de sección (que no tendría lugar sin texto).
                  idx > 0 ? (
                    <div
                      aria-hidden="true"
                      className="mx-2 mb-3 border-t border-border/60"
                    />
                  ) : null
                ) : (
                  <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {section.label}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = pathname?.startsWith(item.href);
                    const Icon = item.icon;
                    const link = (
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex items-center rounded-md text-sm transition-colors',
                          collapsed
                            ? 'justify-center px-2 py-2.5'
                            : 'gap-3 px-3 py-2',
                          active
                            ? 'bg-brand-navy/5 font-medium text-brand-navy'
                            : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {/* La barrita indicadora activa solo tiene sentido en
                            modo expandido (donde el label da contexto). En
                            colapsado, el bg tenue + color del ícono ya
                            comunican el estado activo sin ruido visual. */}
                        {active && !collapsed ? (
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
                        {!collapsed && (
                          <span className="truncate">{item.label}</span>
                        )}
                      </Link>
                    );
                    return (
                      <li key={item.key}>
                        {collapsed ? (
                          <Tooltip>
                            <TooltipTrigger asChild>{link}</TooltipTrigger>
                            <TooltipContent side="right" sideOffset={12}>
                              {item.label}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          link
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {/* User footer con dropdown */}
          <div
            className={cn(
              'border-t border-border',
              collapsed ? 'p-2' : 'p-3',
            )}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('userMenu')}
                  className={cn(
                    'flex w-full items-center rounded-md text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    collapsed
                      ? 'justify-center px-1 py-1.5'
                      : 'gap-3 px-2 py-2',
                  )}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy/10 text-sm font-semibold text-brand-navy">
                    {initials}
                  </div>
                  {!collapsed && (
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {me.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {roleLabel}
                      </p>
                    </div>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align={collapsed ? 'start' : 'end'}
                side={collapsed ? 'right' : 'top'}
                className="w-56"
              >
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-0.5">
                    <p className="text-sm font-medium leading-none">
                      {me.name}
                    </p>
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
      </TooltipProvider>

      {/* Toggle circular flotante sobre el borde derecho del sidebar.
          Vive fuera del <aside> para que el `bg-card + border` del botón
          tape limpiamente el `border-r` del sidebar, generando el efecto
          "roto en la línea". Posicionado con `left` que acompaña el ancho
          del sidebar (transition-[left]) — al colapsar/expandir, el
          botón se desliza con el borde. `-translate-x-1/2` lo centra
          justo sobre la línea. z-20 lo pone arriba del contenido del main
          y del propio sidebar. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
        aria-expanded={!collapsed}
        className={cn(
          'absolute top-16 z-20 hidden h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-[left,background-color,color,box-shadow] duration-200 ease-out hover:bg-accent hover:text-foreground hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex',
          collapsed ? 'left-[68px]' : 'left-64',
        )}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>

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
            <Logo variant="mark" className="h-6 w-6 shrink-0" />
            <p className="min-w-0 truncate text-sm font-semibold">
              {me.clinic?.name ?? 'Showly'}
            </p>
          </div>
          {/* Avatar iniciales — abre logout via dropdown también en mobile */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('userMenu')}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-sm font-semibold text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-navy/10">
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
          Modo normal: el `<main>` es el scroller (root es h-dvh
          overflow-hidden), con el padding y max-width del panel intactos.
          Cualquier ruta que necesite full-viewport puede usar `h-full` en
          su hijo directo — la cadena de contenedores lo permite.
          Modo full-bleed opt-in: para rutas registradas en
          FULL_BLEED_SEGMENTS, se omite padding y max-width para pegar al
          borde de la sidebar del panel.
        */}
        {isFullBleedRoute(pathname) ? (
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col">
              {children}
            </div>
          </main>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * Rutas que necesitan ocupar el viewport entero sin la jaula del contenedor
 * (padding + max-width). Vacío por ahora — el mecanismo queda armado para
 * cuando aparezca una ruta que realmente lo justifique.
 */
const FULL_BLEED_SEGMENTS: readonly string[] = [];

function isFullBleedRoute(pathname: string | null): boolean {
  if (!pathname || FULL_BLEED_SEGMENTS.length === 0) return false;
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
