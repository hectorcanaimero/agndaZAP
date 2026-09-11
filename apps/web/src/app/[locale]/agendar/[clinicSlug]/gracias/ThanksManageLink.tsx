'use client';

import { CalendarCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Bloque "¿necesitas cambiarla?" de /gracias, con el link de gestión de la
 * cita.
 *
 * El link lleva un token bearer: quien lo tenga puede cancelar la cita. Por eso
 * NO viaja en la query string (quedaría en el Referer, el historial y los logs
 * del CDN) sino por `sessionStorage`, igual que el nombre del paciente. Mismo
 * razonamiento que B.4 del ADR [[docs/adr/0004-pii-y-compliance]].
 *
 * Si no hay link no se renderiza nada: el backend no emite token cuando Redis
 * está caído, pero la cita se crea igual — preferimos perder el link que la
 * cita. El paciente sigue teniendo el WhatsApp de la clínica.
 */
export function ThanksManageLink() {
  const t = useTranslations('thanks');
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem('agz.thanks.manageUrl');
      // La guarda no es cosmética: con StrictMode el effect corre dos veces en
      // local, y sin ella la segunda pasada leería `null` (ya borrado) y haría
      // `setUrl(null)`, así que el bloque no aparecería nunca fuera del build.
      if (stored) {
        setUrl(stored);
        // Se consume: si recarga, no lo dejamos ahí indefinidamente.
        window.sessionStorage.removeItem('agz.thanks.manageUrl');
      }
    } catch {
      // no-op: modo privado o similar.
    }
  }, []);

  if (!url) return null;

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm">
      <div className="flex items-center gap-2 text-brand-700">
        <CalendarCog className="h-4 w-4" aria-hidden="true" />
        <p className="text-sm font-semibold">{t('manageTitle')}</p>
      </div>
      <p className="mt-1 text-xs text-gray-600">{t('manageDescription')}</p>
      <a
        href={url}
        className="mt-3 inline-flex h-9 items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 shadow-sm transition-colors hover:border-brand-500 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      >
        {t('manageLink')}
      </a>
    </div>
  );
}
