import { useTranslations } from 'next-intl';
import {
  IconConsultorio,
  IconClinic,
  IconWellness,
  IconSpecialist,
} from './icons';

const CARDS = [
  { key: 'consultorios', Icon: IconConsultorio },
  { key: 'clinicas', Icon: IconClinic },
  { key: 'estetica', Icon: IconWellness },
  { key: 'especialistas', Icon: IconSpecialist },
] as const;

export function ForWhomSection() {
  const t = useTranslations('landing.forWhom');

  return (
    <section className="bg-cream-50 py-24 lg:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <h2
            className="font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-brand-navy sm:text-5xl lg:text-6xl text-balance"
            style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
          >
            {t('headline')}
          </h2>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:mt-20">
          {CARDS.map(({ key, Icon }) => (
            <article
              key={key}
              className="group relative min-w-0 overflow-hidden rounded-[1.75rem] border border-warm-200 bg-cream-50 p-7 shadow-warm-sm transition-all duration-300 ease-out-soft hover:-translate-y-1 hover:border-brand-teal/40 hover:shadow-warm-lg"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-teal/10 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
              />
              <div className="relative flex items-start gap-5">
                <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-teal/10 text-brand-teal ring-1 ring-inset ring-brand-teal/20 transition-transform duration-300 ease-back-out group-hover:scale-110">
                  <Icon className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-xl font-semibold leading-snug text-brand-navy">
                    {t(`cards.${key}.title`)}
                  </h3>
                  <p className="mt-2.5 text-base leading-relaxed text-warm-600">
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
