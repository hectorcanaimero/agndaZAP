import { useLocale, useTranslations } from 'next-intl';
import { ArrowUpRight, CalendarDays, MessageCircle, type LucideIcon } from 'lucide-react';
import { DEMO_CLINIC_SLUG, demoAvailable, demoWhatsappLink } from '@/lib/demo-clinic';

// "Pruébalo ahora": la prueba social que sí tenemos es el producto mismo.
// Bot demo por WhatsApp y página pública de la clínica demo. Cada vía se
// muestra sólo si su env está configurada (ver lib/demo-clinic.ts); sin
// ninguna, la sección no existe. Antes de encenderla en producción, ver
// docs/notas/2026-09-13-demo-publico-landing.md.
export function DemoSection() {
  const t = useTranslations('landing.demo');
  const locale = useLocale();
  if (!demoAvailable) return null;

  const waLink = demoWhatsappLink(t('whatsapp.message'));
  const actions = [
    waLink
      ? { key: 'whatsapp', href: waLink, location: 'demo-whatsapp', Icon: MessageCircle }
      : null,
    DEMO_CLINIC_SLUG
      ? { key: 'web', href: `/${locale}/agendar/${DEMO_CLINIC_SLUG}`, location: 'demo-web', Icon: CalendarDays }
      : null,
  ].filter((a): a is { key: 'whatsapp' | 'web'; href: string; location: string; Icon: LucideIcon } => a !== null);

  return (
    <section id="demo" className="scroll-mt-16 border-y border-mist-200 bg-white py-20 lg:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
          {t('headline')}
        </h2>
        <p className="mt-5 max-w-[40rem] text-lg leading-relaxed text-mist-600">{t('body')}</p>

        <ul className={`mt-10 grid gap-4 ${actions.length > 1 ? 'md:grid-cols-2' : 'max-w-xl'}`}>
          {actions.map(({ key, href, location, Icon }) => (
            <li key={key}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-analytics="cta_click"
                data-analytics-location={location}
                className="group flex h-full flex-col rounded-2xl bg-brand-navy p-6 text-white transition-colors duration-200 hover:bg-[#16375d] sm:p-8"
              >
                <Icon className="h-7 w-7 text-brand-teal" aria-hidden="true" strokeWidth={1.75} />
                <span className="mt-6 block text-2xl font-semibold">{t(`${key}.title`)}</span>
                <span className="mt-2 block text-base leading-relaxed text-white/75">{t(`${key}.body`)}</span>
                <span className="mt-8 inline-flex items-center gap-1.5 text-base font-semibold text-brand-teal">
                  {t(`${key}.cta`)}
                  <ArrowUpRight
                    className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-mist-700">{t('note')}</p>
      </div>
    </section>
  );
}
