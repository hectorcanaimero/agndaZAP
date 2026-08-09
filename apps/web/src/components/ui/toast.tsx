'use client';

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { cn } from '@/lib/utils';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  push: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

/**
 * Toast provider hand-rolled. Auto-dismiss a 4s.
 *
 * Uso:
 * ```tsx
 * const toast = useToast();
 * toast.push('Cita confirmada', 'success');
 * ```
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, message, variant }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {/*
        Container sin aria-live (cada tarjeta trae el suyo). Los errores usan
        role="alert" + assertive; success/info usan role="status" + polite.
        Ver Nit-A8.
      */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const styles: Record<ToastVariant, string> = {
    success: 'bg-green-600 text-white',
    error: 'bg-red-600 text-white',
    info: 'bg-gray-800 text-white',
  };

  // Error: interrupción → role="alert" + assertive. El screen reader corta lo
  // que esté leyendo. Success/info son informativos → role="status" + polite,
  // se anuncian sin interrumpir. Ver Nit-A8.
  const isError = item.variant === 'error';

  return (
    <div
      className={cn(
        'pointer-events-auto min-w-[240px] max-w-sm rounded-md px-4 py-2 text-sm shadow-lg',
        styles[item.variant],
      )}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      {item.message}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback silencioso — el toast puede vivir sin provider en tests unitarios.
    return {
      push: (message: string) => {
        if (typeof console !== 'undefined') {
          // eslint-disable-next-line no-console
          console.log('[toast]', message);
        }
      },
    };
  }
  return ctx;
}
