import { useTranslations } from 'next-intl';
import { LeadForm } from './LeadForm';

// CTA final — statement sobre gradient verde + form inline (no mailto).
// El mailto original mandaba al usuario a abrir su cliente de correo (fricción
// altísima). El form inline captura el lead ahí mismo y persiste en backend
// (endpoint público /public/leads con rate-limit + honeypot).
export function FinalCta() {
  const t = useTranslations('landing.cta');

  return (
    <section id="cta" className="bg-neutral-950 py-20 lg:py-28">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-8 sm:p-12 lg:p-14">
          {/* Textura decorativa sutil — radial de puntos claros. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
          />

          <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-14">
            <div className="min-w-0">
              <h2
                className="max-w-xl font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl"
                style={{ overflowWrap: 'anywhere' }}
              >
                {t('headline')}
              </h2>
              <p className="mt-6 max-w-lg text-base text-brand-50 sm:text-lg">
                {t('subheadline')}
              </p>
              <p className="mt-8 text-sm text-brand-100">{t('trust')}</p>
            </div>

            <div className="min-w-0">
              <LeadForm />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
