import { useTranslations } from 'next-intl';
import { Clock3, Languages, Smartphone, SmartphoneNfc } from 'lucide-react';

// Franja de hechos verificables justo debajo del hero. Reemplaza a las
// pastillas de confianza que vivían dentro del hero y a la sección
// "Para quién". Sin logos ni cifras de clientes: no hay todavía.
const FACTS = [
  { key: 'noApp', Icon: Smartphone },
  { key: 'number', Icon: SmartphoneNfc },
  { key: 'onboarding', Icon: Clock3 },
  { key: 'languages', Icon: Languages },
] as const;

export function Facts() {
  const t = useTranslations('landing.facts');

  return (
    <section aria-label={t('label')} className="border-y border-mist-200 bg-white/60">
      <ul className="mx-auto grid max-w-6xl grid-cols-2 px-4 sm:px-6 lg:grid-cols-4 lg:px-8">
        {FACTS.map(({ key, Icon }, i) => (
          <li
            key={key}
            className={`flex items-center gap-3 py-5 text-sm font-medium text-brand-navy sm:text-[0.95rem] ${
              i % 2 === 1 ? 'pl-4 sm:pl-6' : 'pr-4 sm:pr-6'
            } lg:px-6 lg:first:pl-0 lg:[&:not(:first-child)]:border-l lg:[&:not(:first-child)]:border-mist-200`}
          >
            <Icon className="h-5 w-5 shrink-0 text-teal-ink" aria-hidden="true" strokeWidth={1.75} />
            {t(key)}
          </li>
        ))}
      </ul>
    </section>
  );
}
