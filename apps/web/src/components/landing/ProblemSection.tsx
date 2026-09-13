import { useTranslations } from 'next-intl';
import { NoShowCalculator } from './NoShowCalculator';

// El problema contado con los números del visitante, no con una foto de
// stock ni con cifras de mercado que no podemos respaldar. Titular arriba y
// calculadora a lo ancho: el resultado es el protagonista de la sección.
export function ProblemSection() {
  const t = useTranslations('landing.problem');

  return (
    <section className="py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
          {t('headline')}
        </h2>
        <p className="mt-6 max-w-[40rem] text-lg leading-relaxed text-mist-600">{t('body')}</p>
        <div className="mt-10 lg:mt-12">
          <NoShowCalculator />
        </div>
      </div>
    </section>
  );
}
