'use client';

import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import {
  CalendarCheck,
  CheckCheck,
  CircleAlert,
  Clock,
  LayoutDashboard,
  MessageCircle,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

// "La vida de una cita": el único bloque oscuro de la landing y su momento
// de movimiento principal. En desktop los pasos avanzan con el scroll y la
// agenda de al lado (sticky) cambia de estado; en mobile la agenda avanza
// sola mientras está en pantalla. Con reduced-motion no hay autoplay: la
// agenda muestra el día completo.
//
// Los datos de la agenda son de ejemplo y el aria-label lo dice. Los estados
// son los reales del producto (PENDIENTE, CONFIRMADA, EN_RIESGO, ATENDIDA).

const STEPS = ['write', 'book', 'remind', 'risk', 'panel'] as const;
type StepKey = (typeof STEPS)[number];
type Status = 'writing' | 'pending' | 'confirmed' | 'atRisk' | 'attended';

const STATUS_STYLE: Record<Status, { Icon: LucideIcon; className: string }> = {
  writing: { Icon: MessageCircle, className: 'bg-sky-400/10 text-sky-200 ring-sky-300/25' },
  pending: { Icon: Clock, className: 'bg-amber-400/10 text-amber-200 ring-amber-300/25' },
  confirmed: { Icon: CalendarCheck, className: 'bg-brand-teal/15 text-brand-teal ring-brand-teal/30' },
  atRisk: { Icon: CircleAlert, className: 'bg-rose-400/10 text-rose-200 ring-rose-300/30' },
  attended: { Icon: CheckCheck, className: 'bg-white/5 text-white/60 ring-white/10' },
};

const EVENT_ICON: Record<StepKey, LucideIcon> = {
  write: MessageCircle,
  book: CalendarCheck,
  remind: CheckCheck,
  risk: CircleAlert,
  panel: LayoutDashboard,
};

function agendaFor(step: number) {
  return [
    { time: '09:00', name: 'María F.', service: 'cleaning', status: 'attended' as Status, focus: false },
    {
      time: '10:30',
      name: 'Sofía R.',
      service: 'firstVisit',
      status: (step === 0 ? 'writing' : step === 1 ? 'pending' : 'confirmed') as Status,
      focus: step <= 2,
    },
    {
      time: '11:15',
      name: 'Andrés M.',
      service: 'control',
      status: (step >= 3 ? 'atRisk' : 'pending') as Status,
      focus: step === 3,
    },
    { time: '12:00', name: 'Camila V.', service: 'ortho', status: 'confirmed' as Status, focus: false },
  ] as const;
}

export function Lifecycle() {
  const t = useTranslations('landing.lifecycle');
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const [isDesktop, setIsDesktop] = useState(false);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardInView = useInView(cardRef, { amount: 0.5 });

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Desktop: el paso activo es el que cruza la franja central del viewport.
  useEffect(() => {
    if (!isDesktop) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setStep(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    stepRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [isDesktop]);

  // Mobile: autoplay mientras la agenda se ve; reduced-motion → día completo.
  useEffect(() => {
    if (isDesktop) return;
    if (reduce) {
      setStep(STEPS.length - 1);
      return;
    }
    if (!cardInView) return;
    const id = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2600);
    return () => clearInterval(id);
  }, [isDesktop, reduce, cardInView]);

  const rows = agendaFor(step);
  const stepKey = STEPS[step];
  const EventIcon = EVENT_ICON[stepKey];

  return (
    <section id="how-it-works" className="scroll-mt-16 bg-brand-navy py-20 text-white lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] sm:text-5xl">
          {t('headline')}
        </h2>

        <div className="mt-12 grid gap-12 lg:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <ol className="order-2 border-l border-white/15 lg:order-1">
            {STEPS.map((key, i) => {
              const active = i === step;
              return (
                <li
                  key={key}
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                  data-step={i}
                  className="relative flex py-5 pl-6 lg:min-h-[28vh] lg:items-center lg:py-0"
                >
                  <span
                    aria-hidden="true"
                    className={`absolute -left-px top-5 h-8 w-px transition-colors duration-300 lg:top-1/2 lg:-translate-y-1/2 ${
                      active ? 'bg-brand-teal' : 'bg-transparent'
                    }`}
                  />
                  <div
                    className={`transition-opacity duration-300 ${
                      active || !isDesktop ? 'opacity-100' : 'opacity-40'
                    }`}
                    aria-current={active ? 'step' : undefined}
                  >
                    <h3 className="text-xl font-semibold leading-snug sm:text-2xl">{t(`steps.${key}.title`)}</h3>
                    <p className="mt-2 max-w-md text-base leading-relaxed text-white/70">
                      {t(`steps.${key}.body`)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="order-1 lg:order-2">
            <div className="lg:sticky lg:top-[calc(50vh-12rem)]">
              <div
                ref={cardRef}
                role="img"
                aria-label={t('card.label')}
                className="rounded-2xl bg-white/[0.06] p-5 ring-1 ring-inset ring-white/10 sm:p-6"
              >
                <div className="flex items-center justify-between">
                  <p className="text-lg font-semibold">{t('card.day')}</p>
                  <div aria-hidden="true" className="flex gap-1.5">
                    {STEPS.map((key, i) => (
                      <span
                        key={key}
                        className={`h-1 rounded-full transition-all duration-300 ${
                          i === step ? 'w-5 bg-brand-teal' : 'w-1.5 bg-white/25'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <ul className="mt-5 space-y-2">
                  {rows.map((row) => {
                    const { Icon, className } = STATUS_STYLE[row.status];
                    return (
                      <li
                        key={row.time}
                        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-300 ${
                          row.focus && stepKey !== 'panel' ? 'bg-white/[0.08] ring-1 ring-inset ring-brand-teal/40' : 'bg-white/[0.03]'
                        }`}
                      >
                        <span className="w-11 shrink-0 text-sm tabular-nums text-white/60">{row.time}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{row.name}</span>
                          <span className="block truncate text-xs text-white/50">{t(`card.services.${row.service}`)}</span>
                        </span>
                        <motion.span
                          key={row.status}
                          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${className}`}
                        >
                          <Icon className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={2.25} />
                          {t(`card.status.${row.status}`)}
                        </motion.span>
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-5 min-h-[3.25rem] border-t border-white/10 pt-4">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p
                      key={stepKey}
                      initial={reduce ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduce ? undefined : { opacity: 0, y: -6 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-start gap-2.5 text-sm text-white/85"
                    >
                      <EventIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-teal" aria-hidden="true" />
                      {t(`card.events.${stepKey}`)}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
