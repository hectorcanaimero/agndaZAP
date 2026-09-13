'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Menu, X } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Logo } from './Logo';

// Nav: marca, anclas de la página y el CTA único de la landing.
// Sticky con backdrop blur — no altera el layout, respeta prefers-reduced-motion
// porque solo animamos opacity/transform vía CSS.
export function Nav() {
  const t = useTranslations('landing.nav');
  const locale = useLocale();
  // Con ruta y no sólo #ancla: /seguridad y las legales también usan esta nav.
  const home = `/${locale}`;
  const [open, setOpen] = useState(false);

  const links = [
    { href: `${home}#how-it-works`, label: t('howItWorks') },
    { href: `${home}#features`, label: t('features') },
    { href: `${home}#pricing`, label: t('pricing') },
    { href: `${home}#faq`, label: t('faq') },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-mist-200 bg-mist-50">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label="Showly" className="shrink-0">
          <Logo variant="full" />
        </Link>

        <nav
          className="hidden items-center gap-8 md:flex"
          aria-label="Principal"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="relative text-sm font-medium text-mist-600 transition-colors hover:text-brand-navy after:absolute after:left-0 after:-bottom-1 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-brand-teal after:transition-transform after:duration-300 after:ease-out-soft hover:after:scale-x-100"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link
            href="/login"
            className="text-sm font-medium text-mist-600 transition-colors hover:text-brand-navy"
          >
            {t('signIn')}
          </Link>
          <Button
            asChild
            size="sm"
            className="rounded-full bg-brand-navy px-5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#16375d] focus-visible:ring-2 focus-visible:ring-brand-teal focus-visible:ring-offset-2 focus-visible:ring-offset-mist-50"
          >
            <a
              href={`${home}#cta`}
              data-analytics="cta_click"
              data-analytics-location="nav"
            >
              {t('primaryCta')}
            </a>
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-brand-navy md:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy"
          aria-expanded={open}
          aria-label={open ? t('closeMenu') : t('openMenu')}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-mist-200 bg-mist-50 md:hidden">
          <nav className="flex flex-col gap-1 px-4 py-3" aria-label="Móvil">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-xl px-4 py-3 text-base font-medium text-brand-navy hover:bg-mist-100"
              >
                {l.label}
              </a>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-xl px-4 py-3 text-base font-medium text-brand-navy hover:bg-mist-100"
            >
              {t('signIn')}
            </Link>
            <a
              href={`${home}#cta`}
              data-analytics="cta_click"
              data-analytics-location="nav-mobile"
              onClick={() => setOpen(false)}
              className="mt-2 inline-flex items-center justify-center rounded-full bg-brand-navy px-4 py-3 text-base font-semibold text-white"
            >
              {t('primaryCta')}
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
