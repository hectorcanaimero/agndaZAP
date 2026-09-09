'use client';

import { CalendarPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface Props {
  /** Título del evento, ej. "Cita en Clínica Aurora". */
  title: string;
  /** ISO 8601 (con offset o Z). */
  startISO: string;
  endISO: string;
  location?: string | null;
  description?: string | null;
}

/** 2026-09-09T13:00:00.000Z → 20260909T130000Z (UTC, formato iCalendar). */
function toICSDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 5545: escapar ; , \ y saltos de línea en valores de texto. */
function escapeICS(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function buildICS(p: Props): string {
  const uid = `${toICSDate(p.startISO)}-${Math.random().toString(36).slice(2)}@showly`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Showly//Agendamiento//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date().toISOString())}`,
    `DTSTART:${toICSDate(p.startISO)}`,
    `DTEND:${toICSDate(p.endISO)}`,
    `SUMMARY:${escapeICS(p.title)}`,
    p.location ? `LOCATION:${escapeICS(p.location)}` : null,
    p.description ? `DESCRIPTION:${escapeICS(p.description)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((l): l is string => Boolean(l));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Genera el .ics en el cliente (blob) — no pasa por el servidor ni expone
 * datos del paciente: el evento sólo lleva clínica, servicio y horario.
 */
export function AddToCalendarButton(props: Props) {
  const t = useTranslations('thanks');

  const handleClick = () => {
    const blob = new Blob([buildICS(props)], {
      type: 'text/calendar;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cita.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Diferido: Safari cancela la descarga si se revoca en el mismo tick.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      className="min-h-11 w-full gap-2 border-brand-200 text-brand-700 hover:bg-brand-50"
    >
      <CalendarPlus className="h-4 w-4" aria-hidden="true" />
      {t('addToCalendar')}
    </Button>
  );
}
