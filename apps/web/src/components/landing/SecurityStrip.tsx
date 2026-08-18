import { useTranslations } from 'next-intl';
import { Users2, Lock, EyeOff, KeyRound, ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { FadeIn } from './motion/FadeIn';
import { Stagger, StaggerItem } from './motion/Stagger';

// Banda comprimida que reemplaza la SecuritySection dark en la landing.
// El detalle vive en `/seguridad`; acá dejamos un ancla de 4 chips con
// link para no ocupar 90vh sin perder la señal de seguridad. Uso H3 (no
// H2) para no competir con Pricing/FAQ vecinos.
const CHIPS = [
  { key: 'isolation', Icon: Users2 },
  { key: 'dedicated', Icon: Lock },
  { key: 'noPii', Icon: EyeOff },
  { key: 'accessControl', Icon: KeyRound },
] as const;

export function SecurityStrip() {
  const t = useTranslations('landing.securityStrip');

  return (
    <section id="security" className="bg-neutral-50 py-16 md:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between md:gap-8">
          <div className="max-w-2xl">
            <span className="text-xs font-medium uppercase tracking-widest text-brand-navy">
              {t('eyebrow')}
            </span>
            <h3 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-neutral-900 sm:text-2xl">
              {t('headline')}
            </h3>
          </div>
          <Link
            href="/seguridad"
            aria-label={t('ariaMore')}
            className="inline-flex items-center gap-2 text-sm font-medium text-brand-navy transition-colors hover:text-brand-navy/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy focus-visible:ring-offset-2 rounded-sm"
          >
            <span>{t('ctaLabel')}</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </FadeIn>

        <Stagger
          as="ul"
          className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 md:mt-10 md:grid-cols-4"
        >
          {CHIPS.map(({ key, Icon }) => (
            <StaggerItem
              as="li"
              key={key}
              className="flex h-full items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm"
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal ring-1 ring-inset ring-brand-teal/20">
                <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-medium leading-snug text-neutral-800">
                {t(`chips.${key}.label`)}
              </span>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
