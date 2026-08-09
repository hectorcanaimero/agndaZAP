'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Shape del response de `GET /api/clinics/me/waha/status`.
 *
 * `status` queda como `string` porque WAHA puede evolucionar la enum de
 * estados; el mapeo a estilo se hace acá con `KNOWN_STATUSES` + fallback a
 * UNKNOWN. Definido en el client (y re-importado por `page.tsx`) para evitar
 * el patrón "import type desde un server component" al bundle del cliente.
 */
export interface WahaStatusResponse {
  status: string;
  session: string;
  qr?: string;
}

interface Props {
  initial: WahaStatusResponse;
  /**
   * Token JWT — no lo usamos en T4 (el fetcher del client lee la cookie), pero
   * lo aceptamos como prop para que T5 (acciones + polling) pueda pasarlo a
   * `fetcher` sin cambiar la signature de este componente.
   */
  token: string;
}

/**
 * Mapa status → clases Tailwind del badge.
 *
 * Regla del bloque WAHA (spec):
 *  - WORKING → verde
 *  - STARTING / SCAN_QR_CODE → amarillo (en progreso)
 *  - STOPPED / FAILED → rojo (requiere acción del admin)
 *  - UNKNOWN → gris (transitorio, WAHA down)
 *
 * Reutilizamos las mismas familias de color que `Badge` de agenda
 * (`bg-{color}-100 text-{color}-900 border-{color}-300`) para mantener el
 * lenguaje visual coherente con el resto del panel.
 */
const STATUS_STYLES: Record<string, string> = {
  WORKING: 'bg-green-100 text-green-900 border-green-300',
  STARTING: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  SCAN_QR_CODE: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  STOPPED: 'bg-red-100 text-red-900 border-red-300',
  FAILED: 'bg-red-100 text-red-900 border-red-300',
  UNKNOWN: 'bg-gray-100 text-gray-700 border-gray-300',
};

const KNOWN_STATUSES = new Set([
  'WORKING',
  'STARTING',
  'SCAN_QR_CODE',
  'STOPPED',
  'FAILED',
  'UNKNOWN',
]);

/**
 * Client component — renderiza el estado actual de la sesión WAHA y expone
 * los botones de acción (deshabilitados en T4). T5 va a:
 *  - wirear "Conectar" (POST /start) y "Desconectar" (POST /logout).
 *  - montar polling adaptativo (3s en estados transitorios, 15s en WORKING).
 *
 * Contrato con T5: mantener la signature `Props` estable y que `setState`
 * siga aceptando el mismo shape que devuelve `GET /status`.
 */
export function WhatsappConnectionClient({ initial, token: _token }: Props) {
  const t = useTranslations('panel.whatsapp');
  const [state] = useState<WahaStatusResponse>(initial);

  const statusKey = KNOWN_STATUSES.has(state.status) ? state.status : 'UNKNOWN';
  const badgeClass = STATUS_STYLES[statusKey] ?? STATUS_STYLES.UNKNOWN;
  const statusLabel = t(`status.${statusKey}` as const);
  const showQr = state.status === 'SCAN_QR_CODE' && !!state.qr;

  // TODO(T5): wirear acciones + polling adaptativo acá.
  //   - onConnect  → POST /api/clinics/me/waha/start   → arranca polling 3s.
  //   - onLogout   → confirm() + POST /api/clinics/me/waha/logout → detiene polling.
  //   - useEffect con setTimeout recursivo (nunca setInterval) + cleanup.
  //   - 429 → toast info + backoff a 10s. 502 → toast error.

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
              badgeClass,
            )}
          >
            {statusLabel}
          </span>
          {state.session ? (
            <span className="text-xs text-gray-500">
              {t('sessionLabel')}:{' '}
              <span className="font-mono text-gray-700">{state.session}</span>
            </span>
          ) : null}
        </div>

        <div className="mt-4">
          {showQr ? (
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={state.qr}
                alt={t('qr.alt')}
                width={256}
                height={256}
                className="rounded border border-gray-200"
              />
              <p className="text-xs text-gray-500">{t('qr.help')}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
              <p className="text-sm font-medium text-gray-700">
                {t('empty.title')}
              </p>
              <p className="text-xs text-gray-500">{t('empty.help')}</p>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {/* TODO(T5): habilitar y wirear onClick a POST /waha/start. */}
          <Button type="button" disabled>
            {t('actions.connect')}
          </Button>
          {/* TODO(T5): habilitar, confirm() + wirear a POST /waha/logout. */}
          <Button type="button" variant="ghost" disabled>
            {t('actions.disconnect')}
          </Button>
        </div>
      </div>

      {/*
        Reservado para T5: indicador de "polling activo" (spinner + intervalo
        actual) y timestamp del último check. Lo dejo comentado para que la
        próxima tarea sepa dónde plugearlo sin reflow.
      */}
      {/* <PollingIndicator ... /> */}
    </div>
  );
}
