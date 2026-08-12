import { useTranslations } from 'next-intl';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from './motion/FadeIn';
import { SectionEyebrow } from './SectionEyebrow';

// PricingSection — tier ÚNICO porque el producto está en piloto real.
// Copy 100% honesto: gratis mientras dure el piloto, sin fingir tiers ni
// precios inventados. Cuando salga del piloto se avisa con 30 dias. El
// unico CTA es #cta (mismo form del FinalCta) para no fragmentar el funnel.
//
// Diseño: card centrado sobre bg claro. Featured price grande en Inter bold
// (tamano hero) + lista de features con check verde. Footer note pequena que
// explica el "cuando salgamos del piloto" para evitar sorpresas futuras.
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
    <section id="pricing" className="bg-neutral-50 py-20 lg:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="flex flex-col items-center text-center">
          <SectionEyebrow variant="light">{t('eyebrow')}</SectionEyebrow>
          <h2
            className="mt-3 text-4xl font-bold leading-tight tracking-tight text-neutral-950 sm:text-5xl"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-neutral-600 sm:text-lg">
            {t('subheadline')}
          </p>
        </FadeIn>

        <FadeIn
          as="article"
          delay={0.1}
          className="mt-12 overflow-hidden rounded-3xl border-2 border-brand-navy/20 bg-white shadow-xl shadow-brand-navy/5 lg:mt-16"
        >
          <div className="flex flex-col items-center border-b border-neutral-100 bg-gradient-to-br from-brand-navy/5 via-white to-white p-8 text-center sm:p-10">
            <SectionEyebrow variant="light">{t('badge')}</SectionEyebrow>
            <div className="mt-6 flex items-baseline justify-center gap-2">
              <span className="text-6xl font-extrabold leading-none tracking-tight text-neutral-950 sm:text-7xl">
                {t('price')}
              </span>
              <span className="text-base text-neutral-500">{t('priceNote')}</span>
            </div>
            <p className="mx-auto mt-4 max-w-md text-sm text-neutral-600">
              {t('description')}
            </p>
          </div>

          <div className="p-8 sm:p-10">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              {t('includesTitle')}
            </h3>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {FEATURES.map((key) => (
                <li key={key} className="flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-teal/15 text-brand-navy"
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                  <span className="text-sm text-neutral-800">
                    {t(`features.${key}`)}
                  </span>
                </li>
              ))}
            </ul>

            {/* CTA override a navy — coherente con Hero/Nav. */}
            <Button
              asChild
              size="lg"
              className="mt-8 h-12 w-full text-base bg-brand-navy text-white hover:bg-brand-navy/90"
            >
              <a href="#cta">
                {t('cta')}
                <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
              </a>
            </Button>

            <p className="mt-5 text-center text-xs text-neutral-500">
              {t('afterPilot')}
            </p>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
