import { useLocale, useTranslations } from 'next-intl';
import { ArrowUpRight, CalendarDays, MessageCircle, type LucideIcon } from 'lucide-react';
import { DEMO_CLINIC_SLUG, demoAvailable, demoWhatsappLink } from '@/lib/demo-clinic';

// "Pruébalo ahora": la prueba social que sí tenemos es el producto mismo.
// Bot demo por WhatsApp y página pública de la clínica demo. Cada vía se
// muestra sólo si su env está configurada (ver lib/demo-clinic.ts); sin
// ninguna, la sección no existe.
export function DemoSection() {
  const t = useTranslations('landing.demo');
  const locale = useLocale();
  if (!demoAvailable) return null;

  const waLink = demoWhatsappLink(t('whatsapp.message'));

  return (
    <section id="demo" className="scroll-mt-16 border-y border-mist-200 bg-white py-20 lg:py-24">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-16 lg:px-8">
        <div className="min-w-0">
          <h2 className="text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
            {t('headline')}
          </h2>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-mist-600">{t('body')}</p>
          <p className="mt-6 text-sm text-mist-600">{t('note')}</p>
        </div>

        <ul className="min-w-0 divide-y divide-mist-200 rounded-2xl border border-mist-200">
          {waLink ? (
            <DemoAction
              href={waLink}
              external
              location="demo-whatsapp"
              Icon={MessageCircle}
              title={t('whatsapp.title')}
              body={t('whatsapp.body')}
              cta={t('whatsapp.cta')}
            />
          ) : null}
          {DEMO_CLINIC_SLUG ? (
            <DemoAction
              href={`/${locale}/agendar/${DEMO_CLINIC_SLUG}`}
              external
              location="demo-web"
              Icon={CalendarDays}
              title={t('web.title')}
              body={t('web.body')}
              cta={t('web.cta')}
            />
          ) : null}
        </ul>
      </div>
    </section>
  );
}

function DemoAction({
  href,
  external,
  location,
  Icon,
  title,
  body,
  cta,
}: {
  href: string;
  external?: boolean;
  location: string;
  Icon: LucideIcon;
  title: string;
  body: string;
  cta: string;
}) {
  return (
    <li>
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        data-analytics="cta_click"
        data-analytics-location={location}
        className="group flex items-start gap-5 p-6 transition-colors duration-200 first:rounded-t-2xl last:rounded-b-2xl hover:bg-mist-50 sm:p-8"
      >
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-navy text-brand-teal">
          <Icon className="h-6 w-6" aria-hidden="true" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-semibold text-brand-navy">{title}</span>
          <span className="mt-1 block text-base leading-relaxed text-mist-600">{body}</span>
          <span className="mt-4 inline-flex items-center gap-1 text-base font-semibold text-brand-navy underline decoration-brand-teal decoration-2 underline-offset-4">
            {cta}
            <ArrowUpRight
              className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </span>
        </span>
      </a>
    </li>
  );
}
