'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetcher, type AuthMe } from '@/lib/auth';
import type { ClinicType } from './templates/serviceTemplates';
import type { HourPresetKey } from './templates/hourPresets';

/**
 * Estado del wizard de onboarding — client-side. Fuente de verdad server:
 * `Clinic.onboardingProgress` (JSON abierto). El shell hidrata desde el
 * snapshot SSR de /auth/me y persiste cambios con debounce de 500ms.
 *
 * Nada de este estado es sensible. El backend re-valida cada creación
 * (POST /services, /professionals, etc.) — el context solo coordina la UI
 * entre steps y evita re-fetchs redundantes.
 */
export interface OnboardingState {
  clinicType: ClinicType | null;
  prefillFaqs: boolean;
  serviceId: string | null;
  serviceName: string | null;
  professionalId: string | null;
  hoursPreset: HourPresetKey | null;
}

const DEFAULT_STATE: OnboardingState = {
  clinicType: null,
  prefillFaqs: true,
  serviceId: null,
  serviceName: null,
  professionalId: null,
  hoursPreset: null,
};

/** Total de steps visibles del wizard (excluye celebration como step post). */
export const TOTAL_STEPS = 5;

export interface OnboardingContextValue {
  me: AuthMe;
  state: OnboardingState;
  currentStep: number;
  /** Actualiza el estado y debouncea el PATCH al backend (500ms). */
  patch: (partial: Partial<OnboardingState>) => void;
  /** Marca completed=true. Idempotente en el backend. */
  markCompleted: () => Promise<void>;
  /** Progreso 0-100 para la ProgressBar. Considera 5 steps totales. */
  progressPercent: number;
}

const OnboardingContextObj = createContext<OnboardingContextValue | null>(null);

interface ProviderProps {
  me: AuthMe;
  initialState: OnboardingState;
  currentStep: number;
  children: ReactNode;
}

/**
 * Provider server-hidratado. `initialState` viene del layout.tsx que leyó
 * `me.clinic.onboardingProgress`. `currentStep` se deriva del URL param.
 *
 * El debouncer usa un solo setTimeout que se reinicia con cada `patch`. Sin
 * cola de writes — un patch mientras el anterior está pendiente colapsa.
 * Está ok: el shape es un JSON pequeño y el backend hace merge shallow.
 */
export function OnboardingProvider({
  me,
  initialState,
  currentStep,
  children,
}: ProviderProps) {
  const [state, setState] = useState<OnboardingState>(initialState);
  const pendingRef = useRef<Partial<OnboardingState>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    const payload = pendingRef.current;
    pendingRef.current = {};
    timerRef.current = null;
    if (Object.keys(payload).length === 0) return;
    await fetcher('/api/clinics/me/onboarding', {
      method: 'PATCH',
      body: JSON.stringify({ progress: payload, step: currentStep }),
    });
    // Errores del PATCH se ignoran silenciosamente — reintenta el próximo
    // patch. El wizard tolera pérdida de progreso (peor caso: el user vuelve
    // a un step atrás; los IDs creados en backend siguen ahí).
  }, [currentStep]);

  const patch = useCallback(
    (partial: Partial<OnboardingState>) => {
      setState((prev) => ({ ...prev, ...partial }));
      pendingRef.current = { ...pendingRef.current, ...partial };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush();
      }, 500);
    },
    [flush],
  );

  const markCompleted = useCallback(async () => {
    // Flush pending patches primero para no perder el último cambio.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await flush();
    await fetcher('/api/clinics/me/onboarding', {
      method: 'PATCH',
      body: JSON.stringify({ completed: true, step: currentStep }),
    });
  }, [flush, currentStep]);

  // Cleanup: si el component se desmonta con un patch pendiente, lo mandamos
  // best-effort. Los browsers respetan fetch() en beforeunload solo con
  // keepalive; el fetcher normal puede caerse — aceptable en el MVP.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        void flush();
      }
    };
  }, [flush]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      me,
      state,
      currentStep,
      patch,
      markCompleted,
      progressPercent: Math.round(((currentStep - 1) / TOTAL_STEPS) * 100),
    }),
    [me, state, currentStep, patch, markCompleted],
  );

  return (
    <OnboardingContextObj.Provider value={value}>
      {children}
    </OnboardingContextObj.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContextObj);
  if (!ctx) {
    throw new Error(
      'useOnboarding debe usarse dentro de un <OnboardingProvider>',
    );
  }
  return ctx;
}
