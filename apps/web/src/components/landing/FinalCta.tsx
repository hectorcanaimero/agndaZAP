import { useTranslations } from 'next-intl';
import { LeadForm } from './LeadForm';
import { FadeIn } from './motion/FadeIn';

// CTA final — Batch 4: gradient del brand (navy → teal) reemplaza el
// gradient verde WhatsApp del batch anterior. Razón: el verde compite con
// el WhatsAppMock del Hero y satura la landing con "verde-verde-verde".
// Navy/teal es la paleta del brand Showly (ver docs/notas/2026-08-11-brand-kit-showly.md);
// el teal aparece como acento en el CTA button e invierte la jerarquía
// cromática típica (fondo oscuro navy, botón claro teal).
//
// Contraste: form sobre fondo blanco casi-opaco (bg-white/95) para que los
// inputs se lean sobre el gradient. Padding vertical amplio (py-24/32) para
// darle aire al cierre de la landing.
//
// Motion: envoltorio en <FadeIn> — aparece al scrollear al fondo. Sin
// stagger interno (mantener el bloque como una unidad visual).
export function FinalCta() {
  const t = useTranslations('landing.cta');

  return (
    <section id="cta" className="bg-neutral-50 py-24 md:py-32">
      <FadeIn className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-navy via-[#1a3a5c] to-brand-teal p-8 sm:p-12 lg:p-14">
          {/* Textura decorativa sutil — radial de puntos claros. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
          />

          <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-14">
            <div className="min-w-0">
              <h2
                className="max-w-xl text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl text-balance"
                style={{ overflowWrap: 'anywhere' }}
              >
                {t('headline')}
              </h2>
              <p className="mt-6 max-w-lg text-base text-neutral-100 sm:text-lg">
                {t('subheadline')}
              </p>
              <p className="mt-8 text-sm text-neutral-200">{t('trust')}</p>
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
