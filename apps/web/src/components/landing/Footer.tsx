import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { Logo } from './Logo';

// Ft5 Statement footer — repite el value prop grande + columnas mínimas.
// Evita Ft3 (linkfarm de 4 columnas + social row + copyright) que es AI fingerprint.
export function Footer() {
  const t = useTranslations('landing.footer');
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-neutral-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {/* Statement */}
          <div>
            <Logo variant="full" />
            <p className="mt-4 max-w-sm text-sm text-neutral-600">
              {t('statement')}
            </p>
          </div>

          {/* Product */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              {t('columns.product.title')}
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              <li>
                <a
                  href="#how-it-works"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.product.links.howItWorks')}
                </a>
              </li>
              <li>
                <a
                  href="#features"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.product.links.features')}
                </a>
              </li>
              <li>
                <a
                  href="#pricing"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.product.links.pricing')}
                </a>
              </li>
              <li>
                <a
                  href="#faq"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.product.links.faq')}
                </a>
              </li>
              <li>
                <Link
                  href="/seguridad"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.product.links.security')}
                </Link>
              </li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              {t('columns.company.title')}
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              <li>
                <a
                  href="mailto:hola@showly.tech"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.company.links.contact')}
                </a>
              </li>
              <li>
                <Link
                  href="/login"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.company.links.privacy')}
                </Link>
              </li>
              <li>
                <Link
                  href="/login"
                  className="text-neutral-700 transition-colors hover:text-brand-navy"
                >
                  {t('columns.company.links.terms')}
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-neutral-200 pt-6 text-xs text-neutral-500 sm:flex-row sm:items-center">
          <p>{t('copyright', { year })}</p>
          <LocaleSwitcher label={t('language')} />
        </div>
      </div>
    </footer>
  );
}

function LocaleSwitcher({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true">{label}:</span>
      <Link
        href="/"
        locale="es"
        className="rounded-md px-2 py-1 hover:bg-neutral-100 hover:text-neutral-900"
      >
        ES
      </Link>
      <span aria-hidden="true">·</span>
      <Link
        href="/"
        locale="pt"
        className="rounded-md px-2 py-1 hover:bg-neutral-100 hover:text-neutral-900"
      >
        PT
      </Link>
    </div>
  );
}
