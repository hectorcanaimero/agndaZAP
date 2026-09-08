import { useTranslations } from 'next-intl';
import {
  IconReminder,
  IconHandoff,
  IconMultiPro,
  IconKnowledge,
  IconFeedback,
  IconMultiLang,
} from './icons';
import { FadeIn } from './motion/FadeIn';
import { Stagger, StaggerItem } from './motion/Stagger';

// Anchor card = recordatorios (el diferenciador real anti no-show). Se
// eleva visualmente con doble tamaño, ilustración ambiental (gradient +
// glow) y typography display. Los 5 restantes caen en grid 3x2 con misma
// jerarquía. Rompe la uniformidad "6 cards clonadas" sin caer en el bento
// asimétrico roto del batch previo (usamos grid explícito, no auto-flow).
const SUPPORTING = [
  { key: 'handoff', Icon: IconHandoff },
  { key: 'multiPro', Icon: IconMultiPro },
  { key: 'faq', Icon: IconKnowledge },
  { key: 'feedback', Icon: IconFeedback },
  { key: 'multiTenant', Icon: IconMultiLang },
] as const;

export function FeaturesSection() {
  const t = useTranslations('landing.features');

  return (
    <section id="features" className="bg-cream-50 py-24 lg:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="max-w-2xl">
          <h2
            className="font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-brand-navy sm:text-5xl lg:text-6xl text-balance"
            style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
          >
            {t('headline')}
          </h2>
        </FadeIn>

        <div className="mt-14 grid gap-5 lg:mt-20 lg:grid-cols-12">
          <FadeIn
            as="article"
            className="group relative overflow-hidden rounded-[2rem] border border-brand-navy/15 bg-brand-navy p-8 text-white shadow-warm-xl transition-transform duration-500 ease-out-soft hover:-translate-y-1 sm:p-10 lg:col-span-7 lg:row-span-2 lg:min-h-[420px]"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(at_20%_10%,rgba(40,217,185,0.35),transparent_55%),radial-gradient(at_100%_100%,rgba(40,217,185,0.15),transparent_50%)]"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-grain opacity-[0.05] mix-blend-overlay"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -bottom-24 h-72 w-72 rounded-full bg-brand-teal/20 blur-3xl transition-transform duration-700 ease-out-soft group-hover:scale-110"
            />

            <div className="relative flex h-full flex-col">
              <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-brand-teal ring-1 ring-inset ring-white/15 backdrop-blur-sm">
                <IconReminder className="h-7 w-7" />
              </span>
              <h3 className="mt-8 max-w-md font-display text-3xl font-medium leading-tight tracking-[-0.02em] text-white sm:text-4xl">
                {t('items.reminders.title')}
              </h3>
              <p className="mt-4 max-w-md text-base leading-relaxed text-white/80 sm:text-lg">
                {t('items.reminders.body')}
              </p>
              <div className="mt-auto flex items-center gap-2 pt-8 text-sm font-medium text-brand-teal">
                <span
                  aria-hidden="true"
                  className="relative inline-flex h-2 w-2"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-teal opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-teal" />
                </span>
                {t('items.reminders.tag')}
              </div>
            </div>
          </FadeIn>

          <Stagger
            className="contents"
            gap={0.08}
          >
            {SUPPORTING.map(({ key, Icon }, i) => (
              <StaggerItem
                as="article"
                key={key}
                className={`group relative flex min-w-0 flex-col overflow-hidden rounded-[1.75rem] border border-warm-200 bg-cream-50 p-6 shadow-warm-sm transition-all duration-300 ease-out-soft hover:-translate-y-1 hover:border-brand-teal/40 hover:shadow-warm-lg lg:col-span-5 ${
                  i === 0 ? 'lg:col-start-8' : 'lg:col-span-4'
                } ${i >= 1 && i <= 3 ? 'lg:col-span-4' : ''}`}
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-14 -top-14 h-32 w-32 rounded-full bg-brand-teal/8 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                />
                <div className="relative">
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal ring-1 ring-inset ring-brand-teal/20 transition-transform duration-300 ease-back-out group-hover:scale-110">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold leading-snug text-brand-navy">
                    {t(`items.${key}.title`)}
                  </h3>
                  <p className="mt-2 text-[0.95rem] leading-relaxed text-warm-600">
                    {t(`items.${key}.body`)}
                  </p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  );
}
