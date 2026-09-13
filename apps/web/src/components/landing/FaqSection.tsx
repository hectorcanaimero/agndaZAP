import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';

const QUESTIONS = ['phone', 'install', 'business', 'onboarding', 'privacy', 'price'] as const;

export function FaqSection() {
  const t = useTranslations('landing.faq');

  return (
    <section id="faq" className="scroll-mt-16 py-20 lg:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16 lg:px-8">
        <h2 className="text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl lg:sticky lg:top-24 lg:self-start">
          {t('headline')}
        </h2>

        <div className="divide-y divide-mist-200 border-y border-mist-200">
          {QUESTIONS.map((q) => (
            <details key={q} className="group [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left">
                <span className="text-lg font-semibold leading-snug text-brand-navy">
                  {t(`items.${q}.question`)}
                </span>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-mist-300 text-brand-navy transition-transform duration-300 ease-out-soft group-open:rotate-45">
                  <Plus className="h-4 w-4" aria-hidden="true" strokeWidth={2} />
                </span>
              </summary>
              <p className="max-w-2xl pb-6 pr-12 text-base leading-relaxed text-mist-600">{t(`items.${q}.answer`)}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
