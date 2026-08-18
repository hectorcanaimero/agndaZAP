import { useTranslations } from 'next-intl';
import { FadeIn } from './motion/FadeIn';
import { Stagger, StaggerItem } from './motion/Stagger';
import { SectionEyebrow } from './SectionEyebrow';

// How it works (Batch 3) — fondo brand.navy #0F2A4A para crear contraste
// contra las secciones light vecinas y darle peso visual al núcleo del
// producto. Cada paso lleva imagen ilustrada 4:3 (SVG hand-crafted, ver
// /public/landing/how-step-*.svg + manifest), número discreto en teal +
// título y body en blanco/neutral-300. Zoom sutil en hover con CSS puro
// (nada de framer-motion — eso es Batch 4).
//
// Usamos <img> nativo con dimensiones explícitas (evita CLS) en vez de
// next/image porque son SVG locales (~3KB c/u) y activar `dangerouslyAllowSVG`
// para todo el proyecto sería un cambio global fuera de scope del batch.
const STEPS = [
  { key: 'one', img: '/landing/how-step-1.svg' },
  { key: 'two', img: '/landing/how-step-2.svg' },
  { key: 'three', img: '/landing/how-step-3.svg' },
] as const;

export function HowItWorksSection() {
  const t = useTranslations('landing.howItWorks');

  return (
    <section id="how-it-works" className="bg-brand-navy py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="max-w-3xl">
          <SectionEyebrow variant="dark">{t('eyebrow')}</SectionEyebrow>
          <h2
            className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white text-balance"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
        </FadeIn>

        <Stagger
          as="ol"
          gap={0.12}
          className="mt-16 grid grid-cols-1 gap-8 md:mt-20 md:grid-cols-3 lg:gap-10"
        >
          {STEPS.map(({ key, img }) => (
            <StaggerItem as="li" key={key} className="group flex min-w-0 flex-col">
              <span className="font-mono text-sm font-semibold uppercase tracking-[0.3em] text-brand-teal/70">
                {t(`steps.${key}.number`)}
              </span>

              <div className="mt-4 aspect-[4/3] overflow-hidden rounded-xl ring-1 ring-white/10 bg-white/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img}
                  alt={t(`steps_alt.${key}`)}
                  width={800}
                  height={600}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02]"
                />
              </div>

              <h3 className="mt-6 text-xl font-semibold text-white">
                {t(`steps.${key}.title`)}
              </h3>
              <p className="mt-2 text-base leading-relaxed text-neutral-300">
                {t(`steps.${key}.body`)}
              </p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
