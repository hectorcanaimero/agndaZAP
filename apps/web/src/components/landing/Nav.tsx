'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Menu, X } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Logo } from './Logo';

// Nav canonical SaaS three-section (N1b): brand · nav links · CTA.
// Sticky con backdrop blur — no altera el layout, respeta prefers-reduced-motion
// porque solo animamos opacity/transform vía CSS.
export function Nav() {
  const t = useTranslations('landing.nav');
  const [open, setOpen] = useState(false);

  const links = [
    { href: '#how-it-works', label: t('howItWorks') },
    { href: '#features', label: t('features') },
    { href: '#pricing', label: t('pricing') },
    { href: '#faq', label: t('faq') },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-neutral-200/70 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label="gochat" className="shrink-0">
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
              className="text-sm font-medium text-neutral-700 transition-colors hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 rounded-sm"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link
            href="/login"
            className="text-sm font-medium text-neutral-700 transition-colors hover:text-neutral-950"
          >
            {t('signIn')}
          </Link>
          <Button asChild size="sm">
            <a href="#cta">{t('primaryCta')}</a>
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-neutral-900 md:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          aria-expanded={open}
          aria-label={open ? t('closeMenu') : t('openMenu')}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-neutral-200 bg-white md:hidden">
          <nav className="flex flex-col gap-1 px-4 py-3" aria-label="Móvil">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2.5 text-base font-medium text-neutral-800 hover:bg-neutral-100"
              >
                {l.label}
              </a>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2.5 text-base font-medium text-neutral-800 hover:bg-neutral-100"
            >
              {t('signIn')}
            </Link>
            <a
              href="#cta"
              onClick={() => setOpen(false)}
              className="mt-2 inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-2.5 text-base font-semibold text-white hover:bg-brand-700"
            >
              {t('primaryCta')}
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
