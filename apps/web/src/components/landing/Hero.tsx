import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { demoAvailable } from '@/lib/demo-clinic';
import { HeroChat } from './HeroChat';

// Hero split: la promesa a la izquierda, el producto trabajando a la derecha.
// Máximo cuatro piezas de texto (titular, subtítulo, dos CTAs); los hechos
// de confianza viven en <Facts /> debajo, no acá.
export function Hero() {
  const t = useTranslations('landing.hero');

  return (
    <section className="relative overflow-hidden" data-analytics-view="hero_view">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-10 sm:px-6 sm:pt-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-10 lg:px-8 lg:pb-24 lg:pt-20">
        <div className="min-w-0">
          <h1 className="text-balance text-[2.6rem] font-semibold leading-[1.04] tracking-[-0.035em] text-brand-navy sm:text-6xl lg:text-[4.1rem]">
            {t('headline')}
          </h1>
          <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-mist-600 sm:text-xl">
            {t('subheadline')}
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button
              asChild
              size="lg"
              className="group h-14 rounded-full bg-brand-navy px-7 text-base font-semibold text-white shadow-lift-md transition-[transform,background-color] duration-300 ease-out-soft hover:-translate-y-0.5 hover:bg-[#16375d] active:translate-y-0"
            >
              <a href="#cta" data-analytics="cta_click" data-analytics-location="hero">
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
              className="h-14 rounded-full px-6 text-base font-semibold text-brand-navy hover:bg-brand-navy/5"
            >
              {demoAvailable ? (
                <a href="#demo" data-analytics="cta_click" data-analytics-location="hero-demo">
                  {t('secondaryCta')}
                </a>
              ) : (
                <a href="#how-it-works">{t('secondaryCtaFallback')}</a>
              )}
            </Button>
          </div>
        </div>

        <div className="min-w-0">
          <HeroChat />
        </div>
      </div>
    </section>
  );
}
