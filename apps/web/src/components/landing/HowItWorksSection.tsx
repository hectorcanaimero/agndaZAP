import { useTranslations } from 'next-intl';
import { IconChatWrite, IconCalendarCheck, IconDashboard } from './icons';

// How it works — tres pasos ordinales (los números 01/02/03 son OK acá,
// el contenido ES secuencial). Cada paso lleva su icono custom hand-built
// más el número — doble reforzamiento visual sin caer en iconografía
// genérica (lucide + circulito con número es EL patrón AI landing).
const STEPS = [
  { key: 'one', Icon: IconChatWrite },
  { key: 'two', Icon: IconCalendarCheck },
  { key: 'three', Icon: IconDashboard },
] as const;

export function HowItWorksSection() {
  const t = useTranslations('landing.howItWorks');

  return (
    <section id="how-it-works" className="bg-white py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
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

        <ol className="relative mt-14 grid gap-8 md:grid-cols-3 lg:mt-20 lg:gap-12">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 top-8 hidden h-px bg-gradient-to-r from-transparent via-brand-200 to-transparent md:block"
          />

          {STEPS.map(({ key, Icon }) => (
            <li key={key} className="relative min-w-0">
              <div className="relative z-10 flex items-center gap-3">
                <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl border border-neutral-200 bg-white text-brand-700 shadow-sm">
                  <Icon className="h-7 w-7" />
                </span>
                <span className="font-display text-4xl font-semibold leading-none text-neutral-300">
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
