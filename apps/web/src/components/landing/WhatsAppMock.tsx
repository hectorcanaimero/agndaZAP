import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  BatteryFull,
  Check,
  CheckCheck,
  MoreVertical,
  Phone,
  Signal,
  Video,
  Wifi,
} from 'lucide-react';

// Mock del hero — frame de telefono realista + look inspirado en WhatsApp
// para que el visitante entienda de un vistazo QUE es y COMO se ve. Antes
// era un rectangulo neutral que podia leerse como cualquier chat generico.
//
// Nota de trademark: NO copiamos assets de Meta.
// - No usamos el logo de WhatsApp
// - Los iconos son Lucide (no los exactos de la app)
// - Los colores del header usan NUESTRO brand verde (que casualmente vive
//   en la misma familia visual que WA, pero es nuestro token, no el de Meta).
// - El nombre en el header es "Clínica Aurora" (nuestro ejemplo), no "WhatsApp"
//
// El bot manda opciones como TEXTO PLANO numerado (no quick-reply chips)
// porque WAHA + WhatsApp no soportan chips en el flujo real. El mock
// refleja esto fielmente para no mentir sobre capacidades del producto.
export function WhatsAppMock() {
  const t = useTranslations('landing.hero.mock');

  return (
    <div className="relative isolate mx-auto w-full max-w-[340px] sm:max-w-[380px]">
      {/* Glow suave detras del telefono */}
      <div
        aria-hidden="true"
        className="absolute -inset-8 -z-10 rounded-[3rem] bg-gradient-to-br from-brand-200/60 via-transparent to-brand-100/40 blur-3xl"
      />

      {/* Bezel (marco fisico del telefono) */}
      <div className="rounded-[2.75rem] border border-neutral-800/40 bg-neutral-950 p-2 shadow-[0_35px_80px_-20px_rgba(0,0,0,0.45)]">
        {/* Pantalla */}
        <div className="relative overflow-hidden rounded-[2.25rem] bg-[#ECE5DD]">
          {/* Dynamic Island (notch flotante estilo iPhone moderno) */}
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-2 z-20 h-6 w-24 -translate-x-1/2 rounded-full bg-black"
          />

          {/* Status bar (hora + iconos de sistema) */}
          <div className="flex items-center justify-between bg-brand-700 px-6 pt-2.5 pb-1 text-xs font-semibold text-white">
            <span className="tabular-nums">09:12</span>
            <div
              aria-hidden="true"
              className="flex items-center gap-1 opacity-90"
            >
              <Signal className="h-3 w-3" strokeWidth={2.5} />
              <Wifi className="h-3 w-3" strokeWidth={2.5} />
              <BatteryFull className="h-3.5 w-3.5" strokeWidth={2.5} />
            </div>
          </div>

          {/* Header del chat estilo WhatsApp */}
          <div className="flex items-center gap-3 bg-brand-700 px-3 pb-3 pt-2 text-white">
            <ArrowLeft
              className="h-5 w-5 shrink-0 opacity-90"
              aria-hidden="true"
            />
            <div
              aria-hidden="true"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/95 text-sm font-bold text-brand-800 shadow-sm"
            >
              A
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-tight">
                {t('clinicName')}
              </div>
              <div className="truncate text-[11px] leading-tight opacity-85">
                {t('clinicStatus')}
              </div>
            </div>
            <div
              aria-hidden="true"
              className="flex items-center gap-4 opacity-90"
            >
              <Video className="h-5 w-5" strokeWidth={2} />
              <Phone className="h-4 w-4" strokeWidth={2} />
              <MoreVertical className="h-5 w-5" strokeWidth={2} />
            </div>
          </div>

          {/* Cuerpo del chat con "wallpaper" sutil (textura de puntos sobre
              beige clasico de WA para dar profundidad sin ruido). */}
          <div
            className="relative space-y-2 px-3 py-4 [background-image:radial-gradient(circle_at_1px_1px,rgba(0,0,0,0.04)_1px,transparent_0)] [background-size:16px_16px]"
          >
            <MessagePatient>{t('patient')}</MessagePatient>

            {/* Bot manda opciones como texto plano numerado (limitacion real
                de WAHA — WhatsApp no soporta quick-reply chips en la
                integracion no oficial). */}
            <MessageBot>
              <p className="leading-snug">{t('bot1')}</p>
              <p className="mt-2 whitespace-pre-line leading-snug">
                {t('botOptions')}
              </p>
              <p className="mt-2 text-neutral-500 leading-snug">
                {t('botHint')}
              </p>
            </MessageBot>

            <MessagePatient>{t('patientReply')}</MessagePatient>

            <MessageBot>
              <p className="leading-snug">{t('botConfirm')}</p>
            </MessageBot>

            {/* Separador de "sesion nueva" estilo WA — chip centrado con
                bg opaco sobre el wallpaper. */}
            <div className="flex justify-center py-1">
              <span className="rounded-md bg-[#E1F2FA] px-2.5 py-1 text-[10px] font-medium text-neutral-600 shadow-sm">
                {t('reminderBadge')}
              </span>
            </div>

            <MessageBot>
              <p className="leading-snug">{t('reminderText')}</p>
            </MessageBot>
          </div>

          {/* Home indicator estilo iPhone */}
          <div className="flex items-center justify-center bg-[#ECE5DD] pb-2 pt-1">
            <span
              aria-hidden="true"
              className="h-1 w-32 rounded-full bg-neutral-900/70"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Bubble del paciente (outgoing). Verde claro tipo WhatsApp, alineado a la
// derecha con la "cola" (border-radius asimetrico) en la esquina inferior
// derecha. Timestamp + doble check turquesa (leido).
function MessagePatient({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="relative max-w-[80%] rounded-2xl rounded-br-md bg-[#DCF8C6] px-3 py-2 text-sm text-neutral-900 shadow-sm">
        <div
          className="min-w-0 leading-snug"
          style={{ overflowWrap: 'anywhere' }}
        >
          {children}
        </div>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-neutral-500">
          09:12
          <CheckCheck
            className="h-3 w-3 text-sky-500"
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}

// Bubble del bot (incoming). Blanco, alineado a la izquierda con la cola en
// esquina inferior izquierda. Timestamp + un solo check (enviado).
function MessageBot({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="relative max-w-[85%] rounded-2xl rounded-bl-md bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm">
        <div
          className="min-w-0 leading-snug"
          style={{ overflowWrap: 'anywhere' }}
        >
          {children}
        </div>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-neutral-500">
          09:12
          <Check className="h-3 w-3" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
