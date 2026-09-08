import { useTranslations } from 'next-intl';
import { LeadForm } from './LeadForm';
import { FadeIn } from './motion/FadeIn';

export function FinalCta() {
  const t = useTranslations('landing.cta');

  return (
    <section id="cta" className="bg-cream-100 py-28 md:py-36">
      <FadeIn className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-[2.5rem] bg-gradient-to-br from-brand-navy via-[#152f52] to-[#0a5a4a] p-8 shadow-warm-xl sm:p-12 lg:p-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(at_10%_10%,rgba(40,217,185,0.4),transparent_45%),radial-gradient(at_90%_100%,rgba(255,255,255,0.08),transparent_50%)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-grain opacity-[0.06] mix-blend-overlay"
          />

          <div className="relative grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-16">
            <div className="min-w-0">
              <h2
                className="max-w-xl font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-white sm:text-5xl lg:text-6xl text-balance"
                style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
              >
                {t('headline')}
              </h2>
              <p className="mt-6 max-w-lg text-lg leading-relaxed text-white/85">
                {t('subheadline')}
              </p>
              <p className="mt-8 text-sm text-white/70">{t('trust')}</p>
            </div>

            <div className="min-w-0">
              <LeadForm />
            </div>
          </div>
        </div>
      </FadeIn>
    </section>
  );
}
