import { useTranslations } from 'next-intl';
import { Stethoscope, Hospital, Sparkles, GraduationCap } from 'lucide-react';

const CARDS = [
  { key: 'consultorios', Icon: Stethoscope },
  { key: 'clinicas', Icon: Hospital },
  { key: 'estetica', Icon: Sparkles },
  { key: 'especialistas', Icon: GraduationCap },
] as const;

// Para quién — grid 2x2 desktop, apilado mobile. Rompe el patrón feature-grid
// para no repetir la misma forma dos secciones seguidas.
export function ForWhomSection() {
  const t = useTranslations('landing.forWhom');

  return (
    <section className="bg-white py-20 lg:py-28">
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
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:mt-16">
          {CARDS.map(({ key, Icon }) => (
            <article
              key={key}
              className="group min-w-0 rounded-2xl border border-neutral-200 bg-gradient-to-br from-white to-neutral-50 p-6 transition-colors hover:border-brand-300"
            >
              <div className="flex items-start gap-4">
                <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-100">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-neutral-950">
                    {t(`cards.${key}.title`)}
                  </h3>
                  <p className="mt-2 text-sm text-neutral-600">
                    {t(`cards.${key}.body`)}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
