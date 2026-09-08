import Image from 'next/image';
import { useTranslations } from 'next-intl';

export function ProblemSection() {
  const t = useTranslations('landing.problem');

  const points = ['one', 'two', 'three'] as const;

  return (
    <section className="relative bg-cream-100 py-24 lg:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-16">
          <div className="relative min-w-0">
            <div className="relative aspect-[3/2] overflow-hidden rounded-[2rem] border border-warm-200 shadow-warm-xl">
              <Image
                src="/landing/problem-chaos.jpg"
                alt=""
                fill
                sizes="(min-width: 1024px) 540px, 100vw"
                className="object-cover"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-brand-navy/40 to-transparent"
              />
            </div>
            <div className="absolute -bottom-8 -right-2 hidden max-w-[260px] rounded-2xl border border-warm-200 bg-cream-50 p-5 shadow-warm-lg sm:block">
              <div className="font-display text-3xl font-semibold leading-none tracking-tight text-brand-navy">
                {t('callout.headline')}
              </div>
              <div className="mt-2 text-xs leading-relaxed text-warm-600">
                {t('callout.body')}
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <h2
              className="font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-brand-navy sm:text-5xl lg:text-6xl text-balance"
              style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
            >
              {t('headline')}
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-warm-600">
              {t('subheadline')}
            </p>

            <ul className="mt-10 space-y-7">
              {points.map((k, i) => (
                <li key={k} className="group flex gap-5">
                  <span
                    aria-hidden="true"
                    className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-teal/15 font-display text-sm font-semibold text-brand-navy"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-brand-navy">
                      {t(`points.${k}.title`)}
                    </h3>
                    <p className="mt-1.5 text-base leading-relaxed text-warm-600">
                      {t(`points.${k}.body`)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
