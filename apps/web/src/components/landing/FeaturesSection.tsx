import { useTranslations } from 'next-intl';
import { BookOpenText, CalendarSync, Earth, Headset, Star, type LucideIcon } from 'lucide-react';

// Cinco funcionalidades, cinco celdas (lg: 4+2 / 2+2+2; md: 2 / 1+1 / 1+1; mobile: 1 columna).
// Los recordatorios no están acá porque son la sección <Lifecycle />.
// Dos celdas llevan una muestra real de la UI del producto; el resto, texto.
export function FeaturesSection() {
  const t = useTranslations('landing.features');

  return (
    <section id="features" className="scroll-mt-16 py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="max-w-2xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
          {t('headline')}
        </h2>

        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:mt-16 lg:grid-cols-6">
          <article className="flex min-w-0 flex-col gap-8 rounded-2xl bg-mist-100 p-6 sm:p-8 md:col-span-2 lg:col-span-4 lg:flex-row lg:items-end">
            <FeatureText Icon={Headset} title={t('items.handoff.title')} body={t('items.handoff.body')} />
            <div aria-hidden="true" className="w-full max-w-sm shrink-0 space-y-2 lg:w-72">
              <p className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-[#D9FDD3] px-3 py-2 text-sm text-neutral-900">
                {t('items.handoff.demoPatient')}
              </p>
              <p className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white">
                <Headset className="h-3.5 w-3.5 text-brand-teal" />
                {t('items.handoff.demoTaken')}
              </p>
            </div>
          </article>

          <Cell className="lg:col-span-2" Icon={BookOpenText} title={t('items.faq.title')} body={t('items.faq.body')} />
          <Cell className="lg:col-span-2" Icon={CalendarSync} title={t('items.multiPro.title')} body={t('items.multiPro.body')} />

          <article className="flex min-w-0 flex-col justify-between gap-6 rounded-2xl bg-brand-teal/15 p-6 sm:p-8 lg:col-span-2">
            <FeatureText Icon={Star} title={t('items.feedback.title')} body={t('items.feedback.body')} />
            <div aria-hidden="true" className="flex gap-1 text-brand-navy">
              {[0, 1, 2, 3, 4].map((i) => (
                <Star key={i} className="h-5 w-5" fill={i < 4 ? 'currentColor' : 'none'} strokeWidth={1.75} />
              ))}
            </div>
          </article>

          <Cell className="lg:col-span-2" Icon={Earth} title={t('items.timezone.title')} body={t('items.timezone.body')} />
        </div>
      </div>
    </section>
  );
}

function FeatureText({ Icon, title, body }: { Icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="min-w-0 flex-1">
      <Icon className="h-6 w-6 text-teal-ink" aria-hidden="true" strokeWidth={1.75} />
      <h3 className="mt-5 text-xl font-semibold leading-snug text-brand-navy">{title}</h3>
      <p className="mt-2 max-w-md text-base leading-relaxed text-mist-600">{body}</p>
    </div>
  );
}

function Cell({ className, Icon, title, body }: { className?: string; Icon: LucideIcon; title: string; body: string }) {
  return (
    <article className={`min-w-0 rounded-2xl border border-mist-200 bg-white p-6 sm:p-8 ${className ?? ''}`}>
      <FeatureText Icon={Icon} title={title} body={body} />
    </article>
  );
}
