import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';

const QUESTIONS = [
  'phone',
  'install',
  'business',
  'onboarding',
  'privacy',
  'price',
] as const;

export function FaqSection() {
  const t = useTranslations('landing.faq');

  return (
    <section id="faq" className="bg-cream-50 py-24 lg:py-32">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h2
            className="font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-brand-navy sm:text-5xl lg:text-6xl text-balance"
            style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
          >
            {t('headline')}
          </h2>
        </div>

        <div className="mt-14 divide-y divide-warm-200 overflow-hidden rounded-[1.75rem] border border-warm-200 bg-cream-50 shadow-warm-md lg:mt-20">
          {QUESTIONS.map((q) => (
            <details
              key={q}
              className="group px-6 py-5 transition-colors duration-300 open:bg-cream-100 sm:px-8 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-left focus-visible:outline-none">
                <span className="text-base font-semibold leading-snug text-brand-navy sm:text-lg">
                  {t(`items.${q}.question`)}
                </span>
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-teal/10 text-brand-navy transition-transform duration-300 ease-back-out group-open:rotate-45">
                  <Plus className="h-4 w-4" aria-hidden="true" strokeWidth={2} />
                </span>
              </summary>
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-warm-600">
                {t(`items.${q}.answer`)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
