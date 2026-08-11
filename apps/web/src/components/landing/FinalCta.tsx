import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

// CTA final — statement grande sobre fondo verde brand.
// Rompe el ritmo blanco/gris que viene antes y planta el cierre visual.
// El botón primario invierte a fondo blanco para máximo contraste.
export function FinalCta() {
  const t = useTranslations('landing.cta');

  return (
    <section id="cta" className="bg-neutral-950 py-20 lg:py-28">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-8 sm:p-12 lg:p-16">
          {/* Textura decorativa sutil — Radial de puntos verde claro */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
          />

          <div className="relative">
            <h2
              className="max-w-2xl font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl"
              style={{ overflowWrap: 'anywhere' }}
            >
              {t('headline')}
            </h2>
            <p className="mt-6 max-w-xl text-base text-brand-50 sm:text-lg">
              {t('subheadline')}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                asChild
                size="lg"
                className="h-12 bg-white px-6 text-base text-brand-800 shadow-lg hover:bg-brand-50"
              >
                <a href="mailto:hola@gochat.app?subject=Solicito%20demo">
                  {t('primaryCta')}
                  <ArrowRight
                    className="ml-1 h-4 w-4"
                    aria-hidden="true"
                  />
                </a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 border-white/30 bg-transparent px-6 text-base text-white hover:bg-white/10 hover:text-white"
              >
                <a href="/agendar/demo">{t('secondaryCta')}</a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
