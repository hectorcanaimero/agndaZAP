import Image from 'next/image';
import { useTranslations } from 'next-intl';

// Sección del problema — foto documental real del caos operacional a la
// izquierda (no stock genérico) + narrativa vertical a la derecha.
// Rompe el patrón "3 cards con iconos" que grita AI-generated landing.
export function ProblemSection() {
  const t = useTranslations('landing.problem');

  const points = ['one', 'two', 'three'] as const;

  return (
    <section className="bg-neutral-50 py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-16">
          <div className="relative min-w-0">
            <div className="relative aspect-[3/2] overflow-hidden rounded-3xl border border-neutral-200 shadow-lg shadow-neutral-900/10">
              <Image
                src="/landing/problem-chaos.jpg"
                alt=""
                fill
                sizes="(min-width: 1024px) 540px, 100vw"
                className="object-cover"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/25 to-transparent"
              />
            </div>
            {/* Callout flotante empírico — números verificables por cualquier
                dueña de clínica, sin stats inventadas. i18n via landing.problem.callout. */}
            <div className="absolute -bottom-6 -right-3 hidden max-w-[240px] rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl sm:block">
              <div className="text-2xl font-bold leading-none tracking-tight text-brand-navy">
                {t('callout.headline')}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-neutral-600">
                {t('callout.body')}
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <span className="text-xs font-medium uppercase tracking-widest text-brand-navy">
              {t('eyebrow')}
            </span>
            <h2
              className="mt-3 text-3xl font-bold leading-tight tracking-tight text-neutral-950 sm:text-4xl lg:text-5xl"
              style={{ overflowWrap: 'anywhere' }}
            >
              {t('headline')}
            </h2>
            <p className="mt-6 text-base text-neutral-700 sm:text-lg">
              {t('subheadline')}
            </p>

            <ul className="mt-8 space-y-6">
              {points.map((k) => (
                <li key={k} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-brand-teal"
                  />
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-neutral-950">
                      {t(`points.${k}.title`)}
                    </h3>
                    <p className="mt-1 text-sm text-neutral-600 sm:text-base">
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
