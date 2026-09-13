import { useTranslations } from 'next-intl';
import { ArrowRight, EyeOff, KeyRound, Lock, ShieldCheck, Users2 } from 'lucide-react';
import { Link } from '@/i18n/routing';

const CHIPS = [
  { key: 'isolation', Icon: Users2 },
  { key: 'dedicated', Icon: Lock },
  { key: 'noPii', Icon: EyeOff },
  { key: 'accessControl', Icon: KeyRound },
] as const;

// Franja comprimida de seguridad: un titular, cuatro hechos verificables en
// el código y el enlace a /seguridad, donde está el detalle y lo que todavía
// no tenemos (certificaciones).
export function SecurityStrip() {
  const t = useTranslations('landing.securityStrip');

  return (
    <section id="security" className="border-y border-mist-200 bg-mist-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 lg:flex-row lg:items-center lg:gap-10 lg:px-8">
        <div className="flex items-start gap-3 lg:w-80 lg:shrink-0">
          <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-teal-ink" aria-hidden="true" strokeWidth={1.75} />
          <h2 className="text-lg font-semibold leading-snug text-brand-navy">{t('headline')}</h2>
        </div>
        <ul className="grid flex-1 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {CHIPS.map(({ key, Icon }) => (
            <li key={key} className="flex items-center gap-2.5 text-sm font-medium text-mist-700">
              <Icon className="h-4 w-4 shrink-0 text-brand-navy" aria-hidden="true" strokeWidth={1.75} />
              {t(`chips.${key}.label`)}
            </li>
          ))}
        </ul>
        <Link
          href="/seguridad"
          className="group inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-brand-navy underline decoration-brand-teal decoration-2 underline-offset-4"
        >
          {t('ctaLabel')}
          <ArrowRight
            className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1"
            aria-hidden="true"
          />
        </Link>
      </div>
    </section>
  );
}
