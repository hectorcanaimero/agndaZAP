import { useTranslations } from 'next-intl';
import { MessageCircle } from 'lucide-react';
import { whatsappSalesLink } from '@/lib/whatsapp-sales';
import { LeadForm } from './LeadForm';

// Cierre: la misma acción que el resto de la página ("Unirme al piloto")
// resuelta con el formulario. WhatsApp de ventas queda como alternativa para
// quien prefiere hablar antes, no como un segundo CTA con el mismo peso.
export function FinalCta() {
  const t = useTranslations('landing.cta');
  const waLink = whatsappSalesLink(t('whatsappMessage'));

  return (
    <section id="cta" className="scroll-mt-16 border-t border-mist-200 bg-mist-100 py-20 lg:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:px-8">
        <div className="min-w-0">
          <h2 className="text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-brand-navy sm:text-5xl">
            {t('headline')}
          </h2>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-mist-600">{t('subheadline')}</p>
          <p className="mt-6 max-w-md text-sm leading-relaxed text-mist-700">{t('trust')}</p>
          {waLink ? (
            <p className="mt-8 text-base text-mist-700">
              {t('orWhatsapp')}{' '}
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                data-analytics="cta_click"
                data-analytics-location="final-whatsapp"
                className="inline-flex items-center gap-1.5 font-semibold text-brand-navy underline decoration-brand-teal decoration-2 underline-offset-4"
              >
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
                {t('whatsappCta')}
              </a>
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <LeadForm />
        </div>
      </div>
    </section>
  );
}
