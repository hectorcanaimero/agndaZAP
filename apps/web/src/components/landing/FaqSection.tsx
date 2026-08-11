import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';

const QUESTIONS = [
  'phone',
  'install',
  'business',
  'onboarding',
  'privacy',
  'price',
] as const;

// FAQ con <details>/<summary> nativos — accesibles, sin JS, sin librería.
// El chevron rota via CSS `[&_summary_svg]:group-open:rotate-180`, no vía
// state React.
export function FaqSection() {
  const t = useTranslations('landing.faq');

  return (
    <section id="faq" className="bg-neutral-50 py-20 lg:py-28">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-medium uppercase tracking-widest text-brand-700">
            {t('eyebrow')}
          </span>
          <h2
            className="mt-3 font-display text-2xl font-semibold leading-tight tracking-tight text-neutral-950 sm:text-3xl lg:text-4xl"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
        </div>

        <div className="mt-12 divide-y divide-neutral-200 overflow-hidden rounded-2xl border border-neutral-200 bg-white lg:mt-16">
          {QUESTIONS.map((q) => (
            <details
              key={q}
              className="group px-5 py-4 sm:px-6 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 rounded-sm">
                <span className="text-base font-semibold text-neutral-950 sm:text-lg">
                  {t(`items.${q}.question`)}
                </span>
                <ChevronDown
                  className="mt-1 h-5 w-5 shrink-0 text-neutral-500 transition-transform duration-200 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="mt-3 text-sm text-neutral-600 sm:text-base">
                {t(`items.${q}.answer`)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
