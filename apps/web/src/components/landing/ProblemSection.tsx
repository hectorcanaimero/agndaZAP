import { useTranslations } from 'next-intl';
import { NoShowCalculator } from './NoShowCalculator';

// El problema contado con los números del visitante, no con una foto de
// stock ni con cifras de mercado que no podemos respaldar.
export function ProblemSection() {
  const t = useTranslations('landing.problem');

  return (
    <section className="py-20 lg:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:px-8">
        <div className="min-w-0">
          <h2 className="text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
            {t('headline')}
          </h2>
          <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-mist-600">{t('body')}</p>
        </div>
        <div className="min-w-0">
          <NoShowCalculator />
        </div>
      </div>
    </section>
  );
}
