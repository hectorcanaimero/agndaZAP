import { useTranslations } from 'next-intl';
import { Check, CheckCheck } from 'lucide-react';

// Mock estilizado de conversación por WhatsApp — Hallmark enrichment
// Tier A (CSS/HTML art hand-built). NO imita la UI real de WhatsApp
// (sin barra de status de iOS/Android, sin chrome del sistema).
//
// IMPORTANTE: WhatsApp no soporta quick-reply buttons/chips en flujos con
// WAHA. Todo el intercambio ES texto plano — el bot manda opciones
// numeradas y el paciente responde con el número. El mock refleja esto
// fielmente para no mentir sobre capacidades del producto.
export function WhatsAppMock() {
  const t = useTranslations('landing.hero.mock');

  return (
    <div className="relative isolate">
      <div
        aria-hidden="true"
        className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-gradient-to-br from-brand-100/70 via-transparent to-brand-50/40 blur-2xl"
      />

      <div className="rounded-3xl border border-neutral-200 bg-white p-1.5 shadow-2xl shadow-neutral-900/10">
        <div className="overflow-hidden rounded-[calc(1.5rem-6px)] bg-gradient-to-b from-neutral-50 to-white">
          <div className="flex items-center gap-3 border-b border-neutral-200/80 bg-white/60 px-4 py-3">
            <div
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-full bg-brand-100 font-display text-sm font-semibold text-brand-800"
            >
              A
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-neutral-900 truncate">
                {t('clinicName')}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-brand-700">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-brand-600"
                />
                {t('clinicStatus')}
              </div>
            </div>
          </div>

          <div className="space-y-3 px-4 py-5">
            <MessagePatient>{t('patient')}</MessagePatient>

            {/* Bot manda opciones como texto plano numerado. */}
            <MessageBot>
              <p>{t('bot1')}</p>
              <p className="mt-2 whitespace-pre-line">
                {t('botOptions')}
              </p>
              <p className="mt-2 text-neutral-600">{t('botHint')}</p>
            </MessageBot>

            {/* Paciente responde con el número, como en WhatsApp real. */}
            <MessagePatient>{t('patientReply')}</MessagePatient>

            <MessageBot>
              <p>{t('botConfirm')}</p>
            </MessageBot>

            <div className="flex items-center gap-3 py-2">
              <span
                aria-hidden="true"
                className="h-px flex-1 bg-neutral-200"
              />
              <span className="rounded-full bg-neutral-100 px-3 py-1 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
                {t('reminderBadge')}
              </span>
              <span
                aria-hidden="true"
                className="h-px flex-1 bg-neutral-200"
              />
            </div>

            <MessageBot>
              <p>{t('reminderText')}</p>
            </MessageBot>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessagePatient({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-brand-100 px-3.5 py-2 text-sm text-neutral-900 shadow-sm">
        <div className="min-w-0" style={{ overflowWrap: 'anywhere' }}>
          {children}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-brand-700">
          09:12
          <CheckCheck className="h-3 w-3" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function MessageBot({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-neutral-200 bg-white px-3.5 py-2 text-sm text-neutral-900 shadow-sm">
        <div className="min-w-0" style={{ overflowWrap: 'anywhere' }}>
          {children}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[10px] text-neutral-500">
          09:12
          <Check className="h-3 w-3" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
