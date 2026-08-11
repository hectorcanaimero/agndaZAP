import { useTranslations } from 'next-intl';
import { MessageSquareWarning, CalendarX, Clock } from 'lucide-react';

// Sección de problema — narrativa directa, tres puntos verticales.
// Cierra con una cita honesta de mercado (no un stat inventado).
export function ProblemSection() {
  const t = useTranslations('landing.problem');

  const points = [
    { key: 'one', Icon: MessageSquareWarning },
    { key: 'two', Icon: CalendarX },
    { key: 'three', Icon: Clock },
  ] as const;

  return (
    <section className="bg-neutral-50 py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <span className="text-xs font-medium uppercase tracking-widest text-brand-700">
            {t('eyebrow')}
          </span>
          <h2
            className="mt-3 font-display text-3xl font-semibold leading-tight tracking-tight text-neutral-950 sm:text-4xl lg:text-5xl"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
          <p className="mt-6 text-base text-neutral-700 sm:text-lg">
            {t('subheadline')}
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3 lg:mt-16">
          {points.map(({ key, Icon }) => (
            <article
              key={key}
              className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"
            >
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="mt-5 text-lg font-semibold text-neutral-950">
                {t(`points.${key}.title`)}
              </h3>
              <p className="mt-2 text-sm text-neutral-600">
                {t(`points.${key}.body`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
