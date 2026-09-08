import { useTranslations } from 'next-intl';
import { FadeIn } from './motion/FadeIn';
import { Stagger, StaggerItem } from './motion/Stagger';

const STEPS = [
  { key: 'one', img: '/landing/how-step-1.svg' },
  { key: 'two', img: '/landing/how-step-2.svg' },
  { key: 'three', img: '/landing/how-step-3.svg' },
] as const;

export function HowItWorksSection() {
  const t = useTranslations('landing.howItWorks');

  return (
    <section
      id="how-it-works"
      className="relative overflow-hidden bg-brand-navy py-28 md:py-36"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-40 [background-image:radial-gradient(at_20%_0%,rgba(40,217,185,0.28),transparent_55%),radial-gradient(at_85%_100%,rgba(40,217,185,0.14),transparent_50%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-grain opacity-[0.06] mix-blend-overlay"
      />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <FadeIn className="max-w-3xl">
          <h2
            className="font-display text-5xl font-medium leading-[1.02] tracking-[-0.03em] text-white text-balance md:text-6xl"
            style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
          >
            {t('headline')}
          </h2>
        </FadeIn>

        <Stagger
          as="ol"
          gap={0.12}
          className="mt-20 grid grid-cols-1 gap-10 md:mt-24 md:grid-cols-3 lg:gap-12"
        >
          {STEPS.map(({ key, img }, i) => (
            <StaggerItem as="li" key={key} className="group flex min-w-0 flex-col">
              <div className="flex items-baseline gap-4">
                <span className="font-display text-6xl font-medium leading-none text-brand-teal">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="h-px flex-1 bg-white/15" />
              </div>

              <div className="mt-8 aspect-[4/3] overflow-hidden rounded-2xl ring-1 ring-white/10 bg-white/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img}
                  alt={t(`steps_alt.${key}`)}
                  width={800}
                  height={600}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition-transform duration-700 ease-out-soft group-hover:scale-[1.03]"
                />
              </div>

              <h3 className="mt-7 text-xl font-semibold leading-snug text-white">
                {t(`steps.${key}.title`)}
              </h3>
              <p className="mt-3 text-base leading-relaxed text-white/70">
                {t(`steps.${key}.body`)}
              </p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
