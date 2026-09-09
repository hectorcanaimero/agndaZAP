'use client';

import { CalendarClock, ClipboardList, Stethoscope, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Estado compartido MÍNIMO entre `ScheduleForm` (en la columna principal) y
 * el resumen de la sidebar (`SelectionSummary`). El form sigue siendo la
 * única fuente de verdad (react-hook-form): sólo publica etiquetas ya
 * formateadas vía `setSelection`; acá no hay lógica de negocio.
 *
 * `page.tsx` es un Server Component y no puede pasar callbacks, por eso el
 * puente es un context provider client-side que envuelve ambas columnas.
 */
export interface ScheduleSelection {
  service: string | null;
  professional: string | null;
  /** Fecha y hora ya formateadas en la TZ de la clínica. */
  when: string | null;
}

const EMPTY: ScheduleSelection = { service: null, professional: null, when: null };

interface Ctx {
  selection: ScheduleSelection;
  setSelection: (next: ScheduleSelection) => void;
}

const ScheduleSelectionContext = createContext<Ctx | null>(null);

export function ScheduleSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<ScheduleSelection>(EMPTY);
  const value = useMemo(() => ({ selection, setSelection }), [selection]);
  return (
    <ScheduleSelectionContext.Provider value={value}>
      {children}
    </ScheduleSelectionContext.Provider>
  );
}

/** Tolerante a la ausencia del provider (tests, reuso del form aislado). */
export function useScheduleSelection(): Ctx {
  const ctx = useContext(ScheduleSelectionContext);
  return ctx ?? { selection: EMPTY, setSelection: () => {} };
}

/**
 * Resumen persistente de la elección actual (servicio · profesional · fecha
 * y hora). Sólo se renderiza cuando hay al menos un dato elegido.
 * `aria-live="polite"` para que lectores de pantalla sigan el progreso.
 */
export function SelectionSummary() {
  const t = useTranslations('page.summary');
  const { selection } = useScheduleSelection();
  const rows = [
    { key: 'service', Icon: Stethoscope, value: selection.service },
    { key: 'professional', Icon: User, value: selection.professional },
    { key: 'when', Icon: CalendarClock, value: selection.when },
  ] as const;
  const hasAny = rows.some((r) => r.value);

  return (
    <div aria-live="polite">
      {hasAny ? (
        <div className="rounded-lg border border-brand-100 bg-brand-50/50 p-4 text-sm shadow-sm">
          <div className="flex items-center gap-2 text-brand-700">
            <ClipboardList className="h-4 w-4" aria-hidden="true" />
            <p className="font-semibold">{t('title')}</p>
          </div>
          <dl className="mt-3 space-y-2">
            {rows.map(({ key, Icon, value }) => (
              <div key={key} className="flex items-start gap-2">
                <Icon
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <dt className="text-xs text-gray-500">{t(key)}</dt>
                  <dd
                    className={
                      value
                        ? 'font-medium text-gray-900'
                        : 'text-gray-400'
                    }
                  >
                    {value ?? t('pending')}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
