import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { FadeIn } from './motion/FadeIn';

export function Testimonial() {
  const t = useTranslations('landing.testimonial');

  return (
    <section className="relative overflow-hidden bg-warm-900 py-24 text-white lg:py-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background-image:radial-gradient(at_10%_20%,rgba(40,217,185,0.18),transparent_50%),radial-gradient(at_90%_80%,rgba(15,42,74,0.6),transparent_60%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-grain opacity-[0.06] mix-blend-overlay"
      />

      <FadeIn className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center lg:gap-16">
          <div className="relative min-w-0">
            <div className="relative aspect-square w-full max-w-sm overflow-hidden rounded-[2rem] border border-white/10 shadow-2xl">
              <Image
                src="/landing/testimonial-owner.jpg"
                alt={t('altPortrait')}
                fill
                sizes="(min-width: 1024px) 320px, 100vw"
                className="object-cover"
              />
            </div>
            <div
              aria-hidden="true"
              className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-gradient-to-br from-brand-teal/30 to-transparent blur-3xl"
            />
          </div>

          <figure className="min-w-0">
            <span
              aria-hidden="true"
              className="font-display text-7xl leading-none text-brand-teal/50 sm:text-8xl"
            >
              &ldquo;
            </span>
            <blockquote className="-mt-4">
              <p
                className="font-display text-3xl font-medium leading-[1.15] tracking-[-0.02em] text-white sm:text-4xl lg:text-[2.75rem] text-balance"
                style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
              >
                {t('quote')}
              </p>
            </blockquote>
            <figcaption className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="font-semibold text-white">{t('author')}</span>
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-white/40" />
              <span className="text-white/70">{t('role')}</span>
              <span
                aria-hidden="true"
                className="h-1 w-1 rounded-full bg-white/40"
              />
              <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-teal/30 bg-brand-teal/10 px-2.5 py-0.5 text-xs font-medium text-brand-teal">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-teal" />
                {t('badge')}
              </span>
            </figcaption>
          </figure>
        </div>
      </FadeIn>
    </section>
  );
}
