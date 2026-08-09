'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Client component que muestra el título de la página /gracias leyendo el
 * primer nombre del paciente desde `sessionStorage` (key `agz.thanks.name`).
 *
 * Motivación: no queremos `name` en la query string por privacidad (queda en
 * Referer + historial + logs de CDN). Lo pasamos por sessionStorage al hacer
 * el redirect en `ScheduleForm`. Ver B.4 del ADR
 * [[docs/adr/0004-pii-y-compliance]].
 *
 * Fallback: si sessionStorage falla (modo privado, WebView) o el usuario
 * llegó a esta URL directo, mostramos `t('title', { name: '' })` — el mensaje
 * queda "¡Listo, !" que no es lo ideal pero no rompe nada. En la práctica el
 * usuario siempre llega desde el redirect y sessionStorage está disponible.
 */
export function ThanksName() {
  const t = useTranslations('thanks');
  const [name, setName] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem('agz.thanks.name');
      setName(stored ?? '');
      // Consumimos el valor: si el usuario refresca, no lo persistimos
      // más allá de lo necesario.
      window.sessionStorage.removeItem('agz.thanks.name');
    } catch {
      // no-op: modo privado o similar.
    } finally {
      setHydrated(true);
    }
  }, []);

  // Durante SSR y el primer render pre-hydration mostramos el título sin
  // nombre para evitar mismatch. Post-hydration se rellena.
  if (!hydrated) {
    return (
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-gray-900">
        {t('title', { name: '' })}
      </h1>
    );
  }
  return (
    <h1 className="mt-4 text-2xl font-bold tracking-tight text-gray-900">
      {t('title', { name })}
    </h1>
  );
}
