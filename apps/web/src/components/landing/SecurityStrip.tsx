import { useTranslations } from 'next-intl';
import { Users2, Lock, EyeOff, KeyRound, ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { FadeIn } from './motion/FadeIn';
import { Stagger, StaggerItem } from './motion/Stagger';

const CHIPS = [
  { key: 'isolation', Icon: Users2 },
  { key: 'dedicated', Icon: Lock },
  { key: 'noPii', Icon: EyeOff },
  { key: 'accessControl', Icon: KeyRound },
] as const;

export function SecurityStrip() {
  const t = useTranslations('landing.securityStrip');

  return (
    <section id="security" className="bg-cream-100 py-20 md:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-8">
          <h3 className="max-w-2xl font-display text-2xl font-medium leading-snug tracking-[-0.02em] text-brand-navy sm:text-3xl">
            {t('headline')}
          </h3>
          <Link
            href="/seguridad"
            aria-label={t('ariaMore')}
            className="group inline-flex items-center gap-2 rounded-full text-sm font-semibold text-brand-navy transition-colors hover:text-brand-teal"
          >
            <span>{t('ctaLabel')}</span>
            <ArrowRight
              className="h-4 w-4 transition-transform duration-300 ease-out-soft group-hover:translate-x-1"
              aria-hidden="true"
            />
          </Link>
        </FadeIn>

        <Stagger
          as="ul"
          className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 md:mt-12 md:grid-cols-4"
        >
          {CHIPS.map(({ key, Icon }) => (
            <StaggerItem
              as="li"
              key={key}
              className="flex h-full items-center gap-3 rounded-2xl border border-warm-200 bg-cream-50 px-5 py-4 shadow-warm-sm"
            >
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal ring-1 ring-inset ring-brand-teal/20">
                <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-medium leading-snug text-brand-navy">
                {t(`chips.${key}.label`)}
              </span>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
