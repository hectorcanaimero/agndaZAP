import { useTranslations } from 'next-intl';

// How it works — tres pasos genuinamente ordinales (los números 01/02/03
// están permitidos por Hallmark porque el contenido ES secuencial).
// Layout: tres columnas desktop, apiladas mobile, con línea conectora sutil.
export function HowItWorksSection() {
  const t = useTranslations('landing.howItWorks');

  const steps = ['one', 'two', 'three'] as const;

  return (
    <section id="how-it-works" className="bg-white py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-medium uppercase tracking-widest text-brand-700">
            {t('eyebrow')}
          </span>
          <h2
            className="mt-3 font-display text-3xl font-semibold leading-tight tracking-tight text-neutral-950 sm:text-4xl lg:text-5xl"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
        </div>

        <ol className="relative mt-14 grid gap-8 md:grid-cols-3 lg:mt-20 lg:gap-12">
          {/* Línea conectora horizontal — solo desktop, decorativa */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-transparent via-brand-200 to-transparent md:block"
          />

          {steps.map((key) => (
            <li key={key} className="relative min-w-0">
              <div className="flex items-center gap-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-brand-600 bg-white font-display text-base font-semibold text-brand-700">
                  {t(`steps.${key}.number`)}
                </span>
              </div>
              <h3 className="mt-6 text-xl font-semibold text-neutral-950 sm:text-2xl">
                {t(`steps.${key}.title`)}
              </h3>
              <p className="mt-3 text-base text-neutral-600">
                {t(`steps.${key}.body`)}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
