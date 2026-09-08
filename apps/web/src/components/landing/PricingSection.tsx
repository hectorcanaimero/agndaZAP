import { useTranslations } from 'next-intl';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from './motion/FadeIn';

const FEATURES = [
  'bot',
  'reminders',
  'panel',
  'multiLang',
  'onboarding',
  'unlimited',
] as const;

export function PricingSection() {
  const t = useTranslations('landing.pricing');

  return (
    <section id="pricing" className="relative bg-cream-100 py-24 lg:py-32">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="flex flex-col items-center text-center">
          <h2
            className="font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-brand-navy sm:text-5xl lg:text-6xl text-balance"
            style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
          >
            {t('headline')}
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-warm-600">
            {t('subheadline')}
          </p>
        </FadeIn>

        <FadeIn
          as="article"
          delay={0.1}
          className="relative mt-14 overflow-hidden rounded-[2rem] border border-warm-200 bg-cream-50 shadow-warm-xl lg:mt-20"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-teal/15 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-32 -left-16 h-64 w-64 rounded-full bg-brand-navy/10 blur-3xl"
          />

          <div className="relative flex flex-col items-center border-b border-warm-200 px-8 pb-10 pt-12 text-center sm:px-12">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-teal/30 bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-navy">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-teal" />
              {t('badge')}
            </span>
            <div className="mt-8 flex items-baseline justify-center gap-3">
              <span className="font-display text-7xl font-medium leading-none tracking-[-0.04em] text-brand-navy sm:text-8xl">
                {t('price')}
              </span>
              <span className="text-base text-warm-600">{t('priceNote')}</span>
            </div>
            <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-warm-600">
              {t('description')}
            </p>
          </div>

          <div className="relative px-8 pb-10 pt-8 sm:px-12">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-warm-600">
              {t('includesTitle')}
            </h3>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {FEATURES.map((key) => (
                <li key={key} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-teal text-white"
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                  <span className="text-[0.95rem] leading-snug text-brand-navy">
                    {t(`features.${key}`)}
                  </span>
                </li>
              ))}
            </ul>

            <Button
              asChild
              size="lg"
              className="group mt-10 h-14 w-full rounded-full bg-brand-navy text-base font-semibold text-white shadow-warm-lg transition-transform duration-300 ease-out-soft hover:-translate-y-0.5 hover:shadow-warm-xl hover:bg-brand-navy/95"
            >
              <a href="#cta">
                {t('cta')}
                <ArrowRight
                  className="ml-1 h-4 w-4 transition-transform duration-300 ease-out-soft group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </a>
            </Button>

            <p className="mt-6 text-center text-xs text-warm-600">
              {t('afterPilot')}
            </p>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
