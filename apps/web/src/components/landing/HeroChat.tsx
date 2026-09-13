'use client';

import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  BatteryFull,
  CalendarCheck,
  Check,
  CheckCheck,
  MoreVertical,
  Phone,
  Signal,
  Video,
  Wifi,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// Teléfono del hero. El HTML del servidor ya trae la conversación completa
// hasta el recordatorio (sin JS se entiende igual). En el cliente, cuando el
// teléfono entra en pantalla, se reproduce UNA vez el final de la historia:
// el paciente escribe, responde SÍ y la cita queda confirmada. Es la
// transición de estado que vende Showly, por eso es el único movimiento
// del hero. Con prefers-reduced-motion se muestra el estado final quieto.
//
// Trademark: sin logo ni assets de Meta; íconos lucide y colores propios.
// Las opciones van como texto numerado porque así las manda el bot real
// (WAHA no soporta botones de respuesta rápida).

type Phase = 'idle' | 'typing' | 'reply' | 'confirmed';

export function HeroChat() {
  const t = useTranslations('landing.hero.mock');
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    if (reduce) {
      setPhase('confirmed');
      return;
    }
    if (!inView) return;
    const timers = [
      setTimeout(() => setPhase('typing'), 1400),
      setTimeout(() => setPhase('reply'), 2900),
      setTimeout(() => setPhase('confirmed'), 3900),
    ];
    return () => timers.forEach(clearTimeout);
  }, [inView, reduce]);

  const showReply = phase === 'reply' || phase === 'confirmed';

  return (
    <div
      ref={ref}
      role="img"
      aria-label={t('label')}
      className="relative mx-auto w-full max-w-[300px] sm:max-w-[340px]"
    >
      <div className="rounded-[2.6rem] bg-brand-navy p-2 shadow-lift-lg">
        <div className="relative overflow-hidden rounded-[2.1rem] bg-[#EFEAE2]">
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-2 z-20 h-5 w-20 -translate-x-1/2 rounded-full bg-brand-navy"
          />
          <div className="flex items-center justify-between bg-brand-700 px-6 pb-1 pt-2.5 text-[11px] font-semibold text-white">
            <span className="tabular-nums">09:30</span>
            <div aria-hidden="true" className="flex items-center gap-1 opacity-90">
              <Signal className="h-3 w-3" strokeWidth={2.5} />
              <Wifi className="h-3 w-3" strokeWidth={2.5} />
              <BatteryFull className="h-3.5 w-3.5" strokeWidth={2.5} />
            </div>
          </div>
          <div className="flex items-center gap-3 bg-brand-700 px-3 pb-3 pt-2 text-white">
            <ArrowLeft className="h-5 w-5 shrink-0 opacity-90" aria-hidden="true" />
            <div
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-sm font-semibold text-brand-800"
            >
              A
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-tight">{t('clinicName')}</div>
              <div className="truncate text-[11px] leading-tight opacity-85">
                {phase === 'typing' ? t('typing') : t('clinicStatus')}
              </div>
            </div>
            <div aria-hidden="true" className="flex items-center gap-4 opacity-90">
              <Video className="h-5 w-5" strokeWidth={2} />
              <Phone className="h-4 w-4" strokeWidth={2} />
              <MoreVertical className="h-5 w-5" strokeWidth={2} />
            </div>
          </div>

          {/* Alto fijo y mensajes anclados abajo: lo nuevo empuja lo viejo
              hacia arriba como en un chat real, sin mover el layout. */}
          <div className="flex h-[440px] flex-col justify-end gap-2 overflow-hidden px-3 pb-4 [mask-image:linear-gradient(to_bottom,transparent,black_56px)] sm:h-[470px]">
            <Outgoing>{t('patient')}</Outgoing>
            <Incoming>
              <p>{t('bot1')}</p>
              <p className="mt-1.5 whitespace-pre-line">{t('botOptions')}</p>
              <p className="mt-1.5 text-neutral-500">{t('botHint')}</p>
            </Incoming>
            <Outgoing>{t('patientReply')}</Outgoing>
            <Incoming>{t('botConfirm')}</Incoming>
            <div className="flex justify-center py-1">
              <span className="rounded-md bg-white/80 px-2.5 py-1 text-[10px] font-medium text-neutral-600">
                {t('reminderBadge')}
              </span>
            </div>
            <Incoming>{t('reminderText')}</Incoming>

            <AnimatePresence initial={false}>
              {phase === 'typing' ? (
                <motion.div
                  key="typing"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="flex justify-end"
                >
                  <span className="inline-flex gap-1 rounded-2xl rounded-br-md bg-[#D9FDD3] px-3 py-3">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-neutral-500"
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                  </span>
                </motion.div>
              ) : null}
              {showReply ? (
                <motion.div
                  key="reply"
                  initial={reduce ? false : { opacity: 0, y: 12, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Outgoing>{t('patientConfirm')}</Outgoing>
                </motion.div>
              ) : null}
              {phase === 'confirmed' ? (
                <motion.div
                  key="confirmed"
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="flex justify-center pt-1"
                >
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1.5 text-[11px] font-semibold text-white">
                    <CalendarCheck className="h-3.5 w-3.5 text-brand-teal" aria-hidden="true" />
                    {t('confirmedChip')}
                  </span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function Outgoing({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#D9FDD3] px-3 py-1.5 text-[13px] leading-snug text-neutral-900">
        <div style={{ overflowWrap: 'anywhere' }}>{children}</div>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-neutral-500">
          <CheckCheck className="h-3 w-3 text-sky-600" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function Incoming({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white px-3 py-1.5 text-[13px] leading-snug text-neutral-900">
        <div style={{ overflowWrap: 'anywhere' }}>{children}</div>
        <div className="mt-0.5 flex items-center justify-end text-[10px] text-neutral-500">
          <Check className="h-3 w-3" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
