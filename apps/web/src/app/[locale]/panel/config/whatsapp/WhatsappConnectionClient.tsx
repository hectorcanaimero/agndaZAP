'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { fetcher } from '@/lib/auth';
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
   * Token JWT — el `fetcher` client-side lee el cookie por defecto, pero
   * aceptamos el token explícito por consistencia con el patrón SSR (útil si
   * en el futuro pasamos a un modelo httpOnly + endpoint proxy).
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
 * Cadence del polling adaptativo según status.
 *
 *  - Transitorios (STARTING / SCAN_QR_CODE / UNKNOWN): 3s — queremos ver el QR
 *    apenas WAHA lo emita.
 *  - Estable (WORKING): 15s — baja carga; los cambios ya vienen por webhook al
 *    backend, esto es sólo para reflejar drop de conexión en UI.
 *  - Terminales (STOPPED / FAILED): 0 → sin polling. El usuario tiene que
 *    apretar Conectar para volver a la loop.
 */
const POLL_INTERVAL_MS: Record<string, number> = {
  STARTING: 3000,
  SCAN_QR_CODE: 3000,
  UNKNOWN: 3000,
  WORKING: 15_000,
  STOPPED: 0,
  FAILED: 0,
};

/** Backoff aplicado tras un 429; un solo tick, luego vuelve al ritmo normal. */
const RATE_LIMIT_BACKOFF_MS = 10_000;

function intervalFor(status: string): number {
  return POLL_INTERVAL_MS[status] ?? 3000;
}

/**
 * Client component — renderiza el estado actual de la sesión WAHA y expone
 * los botones de acción. T5 wireó:
 *  - "Conectar" (POST /start) y "Desconectar" (POST /logout) con confirm.
 *  - Polling adaptativo (3s transitorios / 15s WORKING / off terminal).
 *  - setTimeout recursivo (no setInterval) para evitar solapamientos si un
 *    fetch demora más que el intervalo.
 *  - Debounce por request in-flight y por status (Connect deshabilitado si ya
 *    está conectado / conectando; Disconnect deshabilitado si no hay sesión).
 *  - Manejo de 502 (WAHA down): toast error + no rompe polling.
 *  - Manejo de 429 (rate-limit): toast info + 1 tick de 10s antes de volver.
 */
export function WhatsappConnectionClient({ initial, token }: Props) {
  const t = useTranslations('panel.whatsapp');
  const toast = useToast();
  const [state, setState] = useState<WahaStatusResponse>(initial);
  const [inFlight, setInFlight] = useState<'connect' | 'logout' | null>(null);

  // Refs para orquestar el loop de polling sin caer en stale closures.
  //  - `timerRef` guarda el handle del próximo setTimeout para poder cancelarlo.
  //  - `mountedRef` evita setState post-unmount (React 18 dev + StrictMode).
  //  - `statusRef` da acceso siempre-actual al último status dentro del tick
  //    recursivo (que se define una sola vez con useCallback).
  //  - `backoffRef` marca "el próximo tick usa 10s en vez de la cadence normal"
  //    para el caso 429.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const statusRef = useRef(state.status);
  const backoffRef = useRef(false);

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    if (!mountedRef.current) return;
    const base = intervalFor(statusRef.current);
    if (base === 0) return; // status terminal → no repolear.
    const delay = backoffRef.current ? RATE_LIMIT_BACKOFF_MS : base;
    backoffRef.current = false;
    clearTimer();
    timerRef.current = setTimeout(() => {
      void tick();
    }, delay);
    // ESLint: `tick` se referencia acá pero se define abajo — es un cycle
    // deliberado (tick → schedule → tick). Los refs cortan el ciclo de deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTimer]);

  const tick = useCallback(async () => {
    if (!mountedRef.current) return;
    const res = await fetcher<WahaStatusResponse>(
      '/api/clinics/me/waha/status',
      { token },
    );
    if (!mountedRef.current) return;

    if (res.ok) {
      setState(res.data);
    } else if (res.status === 429) {
      toast.push(t('toast.rateLimited'), 'info');
      backoffRef.current = true;
    } else if (res.status === 502) {
      toast.push(t('toast.statusFetchFailed'), 'error');
      // No cortamos el loop — el próximo tick puede recuperar el estado.
    }
    // 401 lo maneja el fetcher (redirect a login), no hace falta hacer nada.

    scheduleNext();
  }, [token, toast, t, scheduleNext]);

  // Arranca / re-arranca el loop cuando cambia el status. Si el status es
  // terminal (STOPPED/FAILED) `scheduleNext` no arma timer y quedamos idle.
  useEffect(() => {
    mountedRef.current = true;
    scheduleNext();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
    // Nos re-suscribimos ante cada cambio de status: entrar a WORKING baja el
    // ritmo a 15s, entrar a STARTING lo sube a 3s, entrar a STOPPED lo apaga.
  }, [state.status, scheduleNext, clearTimer]);

  const onConnect = useCallback(async () => {
    if (inFlight !== null) return;
    setInFlight('connect');
    const res = await fetcher<{ status: string }>(
      '/api/clinics/me/waha/start',
      { method: 'POST', token },
    );
    if (!mountedRef.current) return;
    setInFlight(null);

    if (res.ok) {
      // Optimista: marcamos STARTING para que el badge cambie de inmediato y
      // el loop de polling arranque en cadence 3s hasta ver SCAN_QR_CODE.
      setState((prev) => ({ status: 'STARTING', session: prev.session }));
      return;
    }
    if (res.status === 429) {
      toast.push(t('toast.rateLimited'), 'info');
      return;
    }
    if (res.status === 502) {
      toast.push(t('toast.startFailed'), 'error');
      return;
    }
  }, [inFlight, token, toast, t]);

  const onLogout = useCallback(async () => {
    if (inFlight !== null) return;
    // Confirm nativo — el panel no tiene un patrón de "modal de confirmación"
    // reutilizable (el Modal existente es para detalle de cita). No introducimos
    // uno nuevo acá para no salir del alcance de T5.
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('actions.confirmDisconnect'))) return;

    setInFlight('logout');
    const res = await fetcher<{ status: string }>(
      '/api/clinics/me/waha/logout',
      { method: 'POST', token },
    );
    if (!mountedRef.current) return;
    setInFlight(null);

    if (res.ok) {
      // Optimista: STOPPED corta el polling en el próximo effect.
      setState((prev) => ({ status: 'STOPPED', session: prev.session }));
      return;
    }
    if (res.status === 429) {
      toast.push(t('toast.rateLimited'), 'info');
      return;
    }
    if (res.status === 502) {
      // Otro admin pudo haber desconectado ya → refrescamos el estado real.
      toast.push(t('toast.logoutFailed'), 'error');
      const refresh = await fetcher<WahaStatusResponse>(
        '/api/clinics/me/waha/status',
        { token },
      );
      if (mountedRef.current && refresh.ok) setState(refresh.data);
      return;
    }
  }, [inFlight, token, toast, t]);

  const statusKey = KNOWN_STATUSES.has(state.status) ? state.status : 'UNKNOWN';
  const badgeClass = STATUS_STYLES[statusKey] ?? STATUS_STYLES.UNKNOWN;
  const statusLabel = t(`status.${statusKey}` as const);
  const showQr = state.status === 'SCAN_QR_CODE' && !!state.qr;

  // Estados para deshabilitar botones — combinamos "ya estoy en ese lado" con
  // "hay una request in-flight" (evita doble-click).
  const isBusy = inFlight !== null;
  const isConnectedOrConnecting =
    state.status === 'STARTING' ||
    state.status === 'SCAN_QR_CODE' ||
    state.status === 'WORKING';
  const isDisconnectedOrIdle =
    state.status === 'STOPPED' ||
    state.status === 'FAILED' ||
    state.status === 'UNKNOWN';

  const connectDisabled = isBusy || isConnectedOrConnecting;
  const disconnectDisabled = isBusy || isDisconnectedOrIdle;

  // Copy del cadence actual para el indicador visual.
  const pollMs = intervalFor(state.status);
  const pollingLabel =
    pollMs === 0
      ? t('polling.off')
      : pollMs <= 3000
        ? t('polling.fast')
        : t('polling.slow');

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
          <Button
            type="button"
            onClick={onConnect}
            disabled={connectDisabled}
          >
            {inFlight === 'connect'
              ? t('actions.connecting')
              : t('actions.connect')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onLogout}
            disabled={disconnectDisabled}
          >
            {inFlight === 'logout'
              ? t('actions.disconnecting')
              : t('actions.disconnect')}
          </Button>
        </div>
      </div>

      <div
        className="flex items-center gap-2 text-xs text-gray-500"
        aria-live="polite"
      >
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            pollMs === 0 ? 'bg-gray-300' : 'animate-pulse bg-green-500',
          )}
          aria-hidden="true"
        />
        <span>{pollingLabel}</span>
      </div>
    </div>
  );
}
