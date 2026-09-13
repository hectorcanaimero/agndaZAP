import { useTranslations } from 'next-intl';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

const FEATURES = ['bot', 'reminders', 'panel', 'multiLang', 'onboarding', 'unlimited'] as const;

// El piloto como oferta, no como tabla de precios: gratis ahora y, en el
// mismo panel, qué pasa después. Contestar el "¿y luego?" junto al precio
// baja el miedo a arrepentirse; el ancla es el costo de un no-show, que el
// visitante ya calculó más arriba.
export function PricingSection() {
  const t = useTranslations('landing.pricing');

  return (
    <section id="pricing" className="scroll-mt-16 py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid overflow-hidden rounded-2xl border border-mist-200 bg-white lg:grid-cols-2">
          <div className="flex flex-col p-6 sm:p-10">
            <h2 className="text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
              {t('headline')}
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-mist-600">{t('subheadline')}</p>

            <div className="mt-8 rounded-xl bg-mist-100 p-5 lg:mt-auto">
              <h3 className="text-base font-semibold text-brand-navy">{t('afterTitle')}</h3>
              <p className="mt-2 text-sm leading-relaxed text-mist-700">{t('afterBody')}</p>
            </div>
          </div>

          <div className="flex flex-col border-t border-mist-200 p-6 sm:p-10 lg:border-l lg:border-t-0">
            <h3 className="text-base font-semibold text-brand-navy">{t('includesTitle')}</h3>
            <ul className="mt-5 space-y-3.5">
              {FEATURES.map((key) => (
                <li key={key} className="flex items-start gap-3 text-base text-brand-navy">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-teal text-brand-navy"
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                  {t(`features.${key}`)}
                </li>
              ))}
            </ul>
            <Button
              asChild
              size="lg"
              className="group mt-10 h-14 w-full rounded-full bg-brand-navy text-base font-semibold text-white transition-colors duration-200 hover:bg-[#16375d]"
            >
              <a href="#cta" data-analytics="cta_click" data-analytics-location="pricing">
                {t('cta')}
                <ArrowRight
                  className="ml-1 h-4 w-4 transition-transform duration-300 ease-out-soft group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
