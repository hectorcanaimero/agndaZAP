import { useTranslations } from 'next-intl';
import {
  IconReminder,
  IconHandoff,
  IconKnowledge,
  IconMultiPro,
  IconFeedback,
  IconMultiLang,
} from './icons';

// Bento asymmetric layout — rompe la grid uniforme 3×2 que es el patrón
// canónico de landing SaaS AI-era. Recordatorios (el diferenciador
// principal del producto) ocupa 2 columnas y se destaca con tratamiento
// visual distinto (fondo gradient + textura + icono grande).
const ITEMS = [
  { key: 'reminders', Icon: IconReminder, span: 'md:col-span-2 lg:row-span-2' },
  { key: 'handoff', Icon: IconHandoff, span: '' },
  { key: 'faq', Icon: IconKnowledge, span: '' },
  { key: 'multiPro', Icon: IconMultiPro, span: '' },
  { key: 'feedback', Icon: IconFeedback, span: '' },
  { key: 'multiTenant', Icon: IconMultiLang, span: 'md:col-span-2 lg:col-span-1' },
] as const;

export function FeaturesSection() {
  const t = useTranslations('landing.features');

  return (
    <section id="features" className="bg-white py-20 lg:py-28">
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

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3 lg:auto-rows-[minmax(0,1fr)]">
          {ITEMS.map(({ key, Icon, span }, idx) => {
            const isFeatured = idx === 0;
            return (
              <article
                key={key}
                className={`group relative min-w-0 overflow-hidden rounded-2xl border p-6 transition-shadow hover:shadow-md ${span} ${
                  isFeatured
                    ? 'border-brand-200 bg-gradient-to-br from-brand-50 via-white to-white lg:p-8'
                    : 'border-neutral-200 bg-white'
                }`}
              >
                {isFeatured && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-brand-100/50 blur-2xl"
                  />
                )}
                <div className="relative">
                  <div
                    className={`inline-flex items-center justify-center rounded-xl ${
                      isFeatured
                        ? 'h-12 w-12 bg-brand-600 text-white'
                        : 'h-10 w-10 bg-brand-50 text-brand-700'
                    }`}
                  >
                    <Icon className={isFeatured ? 'h-6 w-6' : 'h-5 w-5'} />
                  </div>
                  <h3
                    className={`mt-5 font-semibold text-neutral-950 ${
                      isFeatured
                        ? 'font-display text-xl sm:text-2xl'
                        : 'text-base'
                    }`}
                  >
                    {t(`items.${key}.title`)}
                  </h3>
                  <p
                    className={`mt-2 leading-relaxed text-neutral-600 ${
                      isFeatured ? 'text-base' : 'text-sm'
                    }`}
                  >
                    {t(`items.${key}.body`)}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
