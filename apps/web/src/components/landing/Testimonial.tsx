import Image from 'next/image';
import { useTranslations } from 'next-intl';

// Sección de testimonio del piloto — humaniza la landing y rompe el
// ritmo card-grid-card-grid entre Features y ForWhom. Copy honesto:
// el badge "Piloto en curso" evita implicar que ya hay cientos de
// clínicas usándolo (sería inventar).
export function Testimonial() {
  const t = useTranslations('landing.testimonial');

  return (
    <section className="bg-neutral-950 py-20 text-white lg:py-28">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center lg:gap-14">
          <div className="relative min-w-0">
            <div className="relative aspect-square w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 shadow-2xl">
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
              className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-brand-500/20 to-transparent blur-3xl"
            />
          </div>

          <figure className="min-w-0">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-widest text-brand-300">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-brand-400"
              />
              {t('badge')}
            </span>
            <blockquote className="mt-6">
              <p
                className="font-display text-2xl leading-snug text-white sm:text-3xl lg:text-4xl"
                style={{ overflowWrap: 'anywhere' }}
              >
                {t('quote')}
              </p>
            </blockquote>
            <figcaption className="mt-6 text-sm text-neutral-300">
              <span className="font-medium text-white">{t('author')}</span>
              <span aria-hidden="true"> · </span>
              <span>{t('role')}</span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
