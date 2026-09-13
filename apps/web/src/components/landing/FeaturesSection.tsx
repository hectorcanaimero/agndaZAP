import { useTranslations } from 'next-intl';
import { CalendarSync, Headset, Star } from 'lucide-react';
import type { ReactNode } from 'react';

// Cinco funcionalidades, cinco celdas (lg: 4+2 / 2+2+2; md: 2 / 1+1 / 1+1;
// mobile: 1 columna). Los recordatorios no están acá porque son la sección
// <Lifecycle />. Cada celda muestra un fragmento de la UI real del producto
// (burbujas de WhatsApp, agenda, zona horaria) en vez de un ícono suelto.
const PROFESSIONALS = [
  { name: 'Dra. Ríos', specialty: 'general' },
  { name: 'Dr. Soto', specialty: 'ortho' },
] as const;

export function FeaturesSection() {
  const t = useTranslations('landing.features');

  return (
    <section id="features" className="scroll-mt-16 py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="max-w-2xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
          {t('headline')}
        </h2>

        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:mt-16 lg:grid-cols-6">
          <Cell className="bg-mist-100 md:col-span-2 lg:col-span-4" title={t('items.handoff.title')} body={t('items.handoff.body')} wide>
            <Bubble side="patient">{t('items.handoff.demoPatient')}</Bubble>
            <p className="mx-auto mt-2 flex w-fit items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white">
              <Headset className="h-3.5 w-3.5 text-brand-teal" />
              {t('items.handoff.demoTaken')}
            </p>
          </Cell>

          <Cell className="border border-mist-200 bg-white lg:col-span-2" title={t('items.faq.title')} body={t('items.faq.body')}>
            <Bubble side="patient">{t('items.faq.demoQuestion')}</Bubble>
            <Bubble side="bot">{t('items.faq.demoAnswer')}</Bubble>
          </Cell>

          <Cell className="border border-mist-200 bg-white lg:col-span-2" title={t('items.multiPro.title')} body={t('items.multiPro.body')}>
            <ul className="divide-y divide-mist-200 rounded-xl border border-mist-200 text-sm">
              {PROFESSIONALS.map((p) => (
                <li key={p.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium text-brand-navy">{p.name}</span>
                    <span className="block text-xs text-mist-600">{t(`items.multiPro.specialties.${p.specialty}`)}</span>
                  </span>
                  <CalendarSync className="h-4 w-4 shrink-0 text-teal-ink" strokeWidth={1.75} />
                </li>
              ))}
            </ul>
          </Cell>

          <Cell className="bg-brand-teal/15 lg:col-span-2" title={t('items.feedback.title')} body={t('items.feedback.body')}>
            <div className="flex gap-1 text-brand-navy">
              {[0, 1, 2, 3, 4].map((i) => (
                <Star key={i} className="h-5 w-5" fill={i < 4 ? 'currentColor' : 'none'} strokeWidth={1.75} />
              ))}
            </div>
          </Cell>

          <Cell className="border border-mist-200 bg-white lg:col-span-2" title={t('items.timezone.title')} body={t('items.timezone.body')}>
            <ul className="space-y-2 text-sm">
              {(['es', 'pt'] as const).map((k) => (
                <li key={k} className="flex items-center justify-between rounded-lg bg-mist-100 px-3 py-2">
                  <span className="font-medium text-brand-navy">{t(`items.timezone.zones.${k}.city`)}</span>
                  <span className="tabular-nums text-mist-700">{t(`items.timezone.zones.${k}.time`)}</span>
                </li>
              ))}
            </ul>
          </Cell>
        </div>
      </div>
    </section>
  );
}

function Cell({
  className,
  title,
  body,
  wide,
  children,
}: {
  className: string;
  title: string;
  body: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={`flex min-w-0 flex-col justify-between gap-8 rounded-2xl p-6 sm:p-8 ${
        wide ? 'lg:flex-row lg:items-end' : ''
      } ${className}`}
    >
      <div className="min-w-0 flex-1">
        <h3 className="text-xl font-semibold leading-snug text-brand-navy">{title}</h3>
        <p className="mt-2 max-w-md text-base leading-relaxed text-mist-600">{body}</p>
      </div>
      <div aria-hidden="true" className={wide ? 'w-full max-w-sm shrink-0 lg:w-72' : 'w-full'}>
        {children}
      </div>
    </article>
  );
}

function Bubble({ side, children }: { side: 'patient' | 'bot'; children: ReactNode }) {
  return side === 'patient' ? (
    <p className="ml-auto mt-2 w-fit max-w-[90%] rounded-2xl rounded-br-md bg-[#D9FDD3] px-3 py-2 text-sm text-neutral-900 first:mt-0">
      {children}
    </p>
  ) : (
    <p className="mt-2 w-fit max-w-[90%] rounded-2xl rounded-bl-md bg-mist-100 px-3 py-2 text-sm text-neutral-900">
      {children}
    </p>
  );
}
