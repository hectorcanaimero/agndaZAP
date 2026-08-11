import { useTranslations } from 'next-intl';
import {
  BellRing,
  UserRoundCheck,
  BookText,
  Users,
  Star,
  Globe2,
} from 'lucide-react';

const ITEMS = [
  { key: 'reminders', Icon: BellRing },
  { key: 'handoff', Icon: UserRoundCheck },
  { key: 'faq', Icon: BookText },
  { key: 'multiPro', Icon: Users },
  { key: 'feedback', Icon: Star },
  { key: 'multiTenant', Icon: Globe2 },
] as const;

// Features grid — 3x2 desktop, 2x3 tablet, 1 columna mobile.
// Sin celebración excesiva: cada tarjeta es un ícono + título + body,
// mismo peso visual (rechaza los patrones "1 feature huge + 5 chiquitas").
export function FeaturesSection() {
  const t = useTranslations('landing.features');

  return (
    <section
      id="features"
      className="bg-neutral-50 py-20 lg:py-28"
    >
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

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3">
          {ITEMS.map(({ key, Icon }) => (
            <article
              key={key}
              className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-6 transition-shadow hover:shadow-md"
            >
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="mt-5 text-base font-semibold text-neutral-950">
                {t(`items.${key}.title`)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                {t(`items.${key}.body`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
