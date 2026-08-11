import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  FlaskConical,
  Languages,
  MessageCircle,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WhatsAppMock } from './WhatsAppMock';

// Trust strip — señales de confianza CONCRETAS Y HONESTAS. No inventamos
// clientes ("+X clínicas"), no fingimos logos de "as featured in". Cada
// chip refleja una realidad verificable del producto o del piloto.
const TRUST_ITEMS = [
  { Icon: FlaskConical, key: 'pilot' },
  { Icon: MessageCircle, key: 'whatsapp' },
  { Icon: Zap, key: 'onboarding' },
  { Icon: Languages, key: 'multilang' },
] as const;

// Hero — copy + trust strip a la izquierda, mock del bot a la derecha.
// La foto de la recepcionista se quito: mandaba un mensaje ambiguo ("va a
// ser reemplazada") justo para el segmento hesitante con automatizacion.
// El mock ahora tiene frame de telefono realista y peso visual suficiente
// para llevar la derecha solo.
export function Hero() {
  const t = useTranslations('landing.hero');

  return (
    <section className="relative overflow-x-clip bg-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 [background-image:linear-gradient(to_right,rgba(0,0,0,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.04)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]"
      />

      <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24 lg:px-8 lg:pb-24 lg:pt-28">
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="min-w-0 lg:pt-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium uppercase tracking-widest text-brand-800">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-brand-600"
              />
              {t('eyebrow')}
            </span>

            <h1
              className="mt-6 font-display text-[2.75rem] font-semibold leading-[1.1] tracking-[-0.02em] text-neutral-950 sm:text-6xl lg:text-[4.25rem]"
              style={{ overflowWrap: 'anywhere' }}
            >
              {t('headline')}
            </h1>

            <p className="mt-6 max-w-xl text-base text-neutral-700 sm:text-lg lg:text-xl">
              {t('subheadline')}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="h-12 px-6 text-base">
                <a href="#cta">
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
                className="h-12 px-6 text-base"
              >
                <a href="#how-it-works">{t('secondaryCta')}</a>
              </Button>
            </div>

            {/*
              Trust strip: chips inline con icono + label. Visual: chips
              transparentes con borde neutral suave — no compiten con el
              CTA primario. En mobile hacen wrap natural (gap-y-2), en
              desktop caen en una sola fila hasta lg.
            */}
            <ul className="mt-8 flex flex-wrap items-center gap-x-2.5 gap-y-2">
              {TRUST_ITEMS.map(({ Icon, key }) => (
                <li
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 backdrop-blur"
                >
                  <Icon
                    className="h-3.5 w-3.5 text-brand-700"
                    aria-hidden="true"
                  />
                  {t(`trustStrip.${key}`)}
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0">
            <WhatsAppMock />
          </div>
        </div>
      </div>
    </section>
  );
}
