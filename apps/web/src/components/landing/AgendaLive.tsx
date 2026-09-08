'use client';

import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Check, Clock, AlertCircle, CheckCheck, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

type Status = 'confirmed' | 'pending' | 'atRisk' | 'attended';

interface Appointment {
  time: string;
  name: string;
  service: string;
  status: Status;
}

// Estados iniciales — 5 citas del día de una clínica ficticia. La cita de
// las 10:30 es la que anima en vivo: pending → confirmed cada 4s. Es lo
// que HACE Showly, no un mockup falso de teléfono.
const INITIAL: Appointment[] = [
  { time: '09:00', name: 'María F.', service: 'Consulta general', status: 'attended' },
  { time: '09:45', name: 'Diego A.', service: 'Control mensual', status: 'confirmed' },
  { time: '10:30', name: 'Sofía R.', service: 'Primera cita', status: 'pending' },
  { time: '11:15', name: 'Andrés M.', service: 'Consulta general', status: 'atRisk' },
  { time: '12:00', name: 'Camila V.', service: 'Control mensual', status: 'confirmed' },
];

const STATUS_CONFIG: Record<
  Status,
  { label: 'attended' | 'confirmed' | 'pending' | 'atRisk'; dot: string; text: string; bg: string; ring: string; Icon: typeof Check }
> = {
  attended: {
    label: 'attended',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    bg: 'bg-emerald-500/10',
    ring: 'ring-emerald-500/25',
    Icon: CheckCheck,
  },
  confirmed: {
    label: 'confirmed',
    dot: 'bg-brand-teal',
    text: 'text-brand-teal',
    bg: 'bg-brand-teal/10',
    ring: 'ring-brand-teal/30',
    Icon: Check,
  },
  pending: {
    label: 'pending',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    bg: 'bg-amber-500/10',
    ring: 'ring-amber-500/25',
    Icon: Clock,
  },
  atRisk: {
    label: 'atRisk',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    bg: 'bg-rose-500/10',
    ring: 'ring-rose-500/25',
    Icon: AlertCircle,
  },
};

export function AgendaLive() {
  const t = useTranslations('landing.agendaLive');
  const reduce = useReducedMotion();
  const [items, setItems] = useState<Appointment[]>(INITIAL);
  const [pulseIdx, setPulseIdx] = useState<number | null>(null);

  useEffect(() => {
    if (reduce) return;
    let step = 0;
    const cycle = setInterval(() => {
      step = (step + 1) % 3;
      setItems((prev) => {
        const next = [...prev];
        if (step === 0) {
          next[2] = { ...next[2], status: 'confirmed' };
          setPulseIdx(2);
        } else if (step === 1) {
          next[3] = { ...next[3], status: 'confirmed' };
          setPulseIdx(3);
        } else {
          setPulseIdx(null);
          return INITIAL;
        }
        return next;
      });
      setTimeout(() => setPulseIdx(null), 1600);
    }, 3200);
    return () => clearInterval(cycle);
  }, [reduce]);

  const counts = items.reduce(
    (acc, a) => {
      acc[a.status] = (acc[a.status] || 0) + 1;
      return acc;
    },
    {} as Record<Status, number>,
  );

  const now = new Date();
  const today = now.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="relative w-full max-w-[420px]">
      {/* Layered depth: ghost card detrás para dar sensación de app viva. */}
      <div
        aria-hidden="true"
        className="absolute -right-4 -top-4 h-full w-full rounded-[1.75rem] border border-white/5 bg-white/[0.02] backdrop-blur-sm"
      />
      <div
        aria-hidden="true"
        className="absolute -right-2 -top-2 h-full w-full rounded-[1.75rem] border border-white/10 bg-white/[0.04]"
      />

      <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-6 backdrop-blur-xl shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-teal">
              {t('todayLabel')}
            </div>
            <div className="mt-1 font-display text-xl font-medium text-white first-letter:uppercase">
              {today}
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            {t('liveLabel')}
          </span>
        </div>

        <ul className="mt-6 space-y-2">
          {items.map((appt, i) => {
            const cfg = STATUS_CONFIG[appt.status];
            const isPulsing = pulseIdx === i;
            return (
              <motion.li
                key={i}
                layout={!reduce}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={`relative flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 ${
                  isPulsing ? 'ring-2 ring-brand-teal/40' : ''
                }`}
              >
                <AnimatePresence>
                  {isPulsing && !reduce && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="pointer-events-none absolute inset-0 rounded-xl bg-brand-teal/5"
                    />
                  )}
                </AnimatePresence>

                <div className="w-12 shrink-0 font-display text-sm font-medium text-white/60 tabular-nums">
                  {appt.time}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/5 text-white/50">
                      <User className="h-3 w-3" strokeWidth={2} />
                    </span>
                    <span className="truncate">{appt.name}</span>
                  </div>
                  <div className="mt-0.5 truncate pl-8 text-[11px] text-white/40">
                    {appt.service}
                  </div>
                </div>

                <motion.div
                  key={appt.status}
                  initial={reduce ? {} : { scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.35, ease: [0.34, 1.56, 0.64, 1] }}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${cfg.bg} ${cfg.text} ${cfg.ring}`}
                >
                  <cfg.Icon className="h-3 w-3" strokeWidth={2.5} />
                  {t(`status.${cfg.label}`)}
                </motion.div>
              </motion.li>
            );
          })}
        </ul>

        <div className="mt-6 flex items-center justify-between border-t border-white/5 pt-4">
          <div className="flex items-center gap-3 text-[11px] text-white/50">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-brand-teal" />
              <motion.span
                key={counts.confirmed || 0}
                initial={reduce ? {} : { y: -6, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="font-medium text-white tabular-nums"
              >
                {counts.confirmed || 0}
              </motion.span>
              {t('countLabels.confirmed')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="font-medium text-white tabular-nums">
                {counts.pending || 0}
              </span>
              {t('countLabels.pending')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-400" />
              <span className="font-medium text-white tabular-nums">
                {counts.atRisk || 0}
              </span>
              {t('countLabels.atRisk')}
            </span>
          </div>
        </div>
      </div>

      {/* Floating "chip" que emula un mensaje del bot llegando */}
      <motion.div
        initial={reduce ? {} : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="absolute -bottom-6 -left-6 hidden max-w-[260px] items-start gap-2.5 rounded-2xl border border-white/10 bg-brand-navy/95 p-3.5 shadow-2xl backdrop-blur-lg sm:flex"
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-teal/20 text-brand-teal">
          <CheckCheck className="h-4 w-4" strokeWidth={2.5} />
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-teal">
            {t('toastLabel')}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-white/85">
            {t('toastMessage')}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
