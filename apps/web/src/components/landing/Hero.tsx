import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  FlaskConical,
  Languages,
  MessageCircle,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from './motion/FadeIn';
import { WhatsAppMock } from './WhatsAppMock';

const TRUST_ITEMS = [
  { Icon: FlaskConical, key: 'pilot' },
  { Icon: MessageCircle, key: 'whatsapp' },
  { Icon: Zap, key: 'onboarding' },
  { Icon: Languages, key: 'multilang' },
] as const;

export function Hero() {
  const t = useTranslations('landing.hero');

  return (
    <section
      className="relative isolate overflow-hidden bg-cream-50"
      data-analytics-view="hero_view"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-20 bg-mesh-hero"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-grain opacity-[0.08] mix-blend-multiply"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[-8rem] top-24 -z-10 hidden h-[520px] w-[520px] rounded-full bg-brand-teal/25 blur-[110px] lg:block"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 bottom-0 -z-10 h-[360px] w-[360px] rounded-full bg-brand-navy/10 blur-[100px]"
      />

      <div className="mx-auto max-w-6xl px-4 pb-20 pt-20 sm:px-6 sm:pt-28 lg:px-8 lg:pb-28 lg:pt-32">
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-8">
          <FadeIn className="relative z-10 min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-navy/15 bg-white/60 px-3 py-1 text-xs font-medium text-brand-navy shadow-warm-sm">
              <span
                aria-hidden="true"
                className="relative inline-flex h-2 w-2"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-teal opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-teal" />
              </span>
              {t('eyebrow')}
            </p>

            <h1
              className="mt-6 font-display text-[3.25rem] font-medium leading-[1.02] tracking-[-0.035em] text-brand-navy sm:text-[4rem] lg:text-[5.25rem] text-balance"
              style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
            >
              {t('headline')}
            </h1>

            <p className="mt-7 max-w-xl text-lg leading-relaxed text-warm-600 sm:text-xl">
              {t('subheadline')}
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                asChild
                size="lg"
                className="group relative h-14 overflow-hidden rounded-full bg-brand-navy px-7 text-base font-semibold text-white shadow-warm-lg transition-transform duration-300 ease-out-soft hover:-translate-y-0.5 hover:shadow-warm-xl"
              >
                <a
                  href="#cta"
                  data-analytics="cta_click"
                  data-analytics-location="hero"
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 -z-10 bg-gradient-to-r from-brand-navy via-brand-navy to-brand-teal/40 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  />
                  {t('primaryCta')}
                  <ArrowRight
                    className="ml-1 h-4 w-4 transition-transform duration-300 ease-out-soft group-hover:translate-x-1"
                    aria-hidden="true"
                  />
                </a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="group h-14 rounded-full px-6 text-base font-semibold text-brand-navy hover:bg-brand-navy/5"
              >
                <a href="#how-it-works">
                  {t('secondaryCta')}
                  <span
                    aria-hidden="true"
                    className="ml-1 inline-block transition-transform duration-300 ease-out-soft group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </a>
              </Button>
            </div>

            <ul className="mt-10 flex flex-wrap items-center gap-2.5">
              {TRUST_ITEMS.map(({ Icon, key }) => (
                <li
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-warm-200 bg-cream-50 px-3 py-1.5 text-xs font-medium text-warm-600 shadow-warm-sm"
                >
                  <Icon
                    className={`h-3.5 w-3.5 ${
                      key === 'whatsapp' ? 'text-brand-700' : 'text-brand-teal'
                    }`}
                    aria-hidden="true"
                  />
                  {t(`trustStrip.${key}`)}
                </li>
              ))}
            </ul>
          </FadeIn>

          <FadeIn className="relative min-w-0 lg:-ml-6" delay={0.15}>
            <div className="relative mx-auto w-full max-w-[360px] lg:max-w-[380px]">
              <div
                aria-hidden="true"
                className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-br from-brand-teal/30 via-cream-100/40 to-transparent blur-2xl"
              />
              <div className="relative">
                <WhatsAppMock />
              </div>
              <div
                aria-hidden="true"
                className="absolute -right-4 top-16 hidden h-16 w-16 rounded-full bg-brand-teal/20 blur-lg lg:block"
              />
              <div
                aria-hidden="true"
                className="absolute -left-6 bottom-24 hidden h-20 w-20 rounded-full bg-brand-navy/10 blur-xl lg:block"
              />
            </div>
          </FadeIn>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-cream-50"
      />
    </section>
  );
}
