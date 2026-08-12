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
import { SectionEyebrow } from './SectionEyebrow';

// Grid uniforme 1×6 → 2×3 → 3×2 (Batch 3). Se eliminó el bento asimétrico
// del batch anterior porque generaba huecos visuales en el breakpoint lg y
// una jerarquía injustificada (ningún feature "gana" al resto). Ahora 6
// cards del mismo peso, ordenadas narrativamente para el dueño de clínica:
// 1) recordatorios (el diferenciador), 2) handoff (humaniza), 3) multi-pro
// (setup), 4) faq (autoservicio), 5) feedback (ciclo cerrado), 6) idiomas
// (ancla LATAM). Iconos con acento teal — patrón consistente con la banda
// de seguridad y el resto del brand kit.
const ITEMS = [
  { key: 'reminders', Icon: IconReminder },
  { key: 'handoff', Icon: IconHandoff },
  { key: 'multiPro', Icon: IconMultiPro },
  { key: 'faq', Icon: IconKnowledge },
  { key: 'feedback', Icon: IconFeedback },
  { key: 'multiTenant', Icon: IconMultiLang },
] as const;

export function FeaturesSection() {
  const t = useTranslations('landing.features');

  return (
    <section id="features" className="bg-white py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="max-w-2xl">
          <SectionEyebrow variant="light">{t('eyebrow')}</SectionEyebrow>
          <h2
            className="mt-3 text-4xl font-bold leading-tight tracking-tight text-neutral-950 sm:text-5xl text-balance"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
        </FadeIn>

        <Stagger className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:mt-16">
          {ITEMS.map(({ key, Icon }) => (
            <StaggerItem
              as="article"
              key={key}
              className="group relative flex h-full min-w-0 flex-col rounded-2xl border border-neutral-200 bg-white p-6 transition-colors duration-200 hover:border-brand-teal/40 md:p-8"
            >
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal ring-1 ring-inset ring-brand-teal/20">
                <Icon className="h-6 w-6" />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-neutral-900">
                {t(`items.${key}.title`)}
              </h3>
              <p className="mt-2 text-neutral-600 leading-relaxed">
                {t(`items.${key}.body`)}
              </p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
