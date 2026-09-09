'use client';

import { CalendarPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface Props {
  /** Título del evento, ej. "Cita en Clínica Aurora". */
  title: string;
  /** ISO 8601 con offset o Z (validado en /gracias con Luxon). */
  startISO: string;
  endISO: string;
  /**
   * UID estable del evento (RFC 5545 §3.8.4.7): descargar dos veces el .ics
   * actualiza el mismo evento en vez de duplicarlo. Lo calcula /gracias a
   * partir del id de la cita (o de un hash determinista como fallback).
   */
  uid: string;
  location?: string | null;
  description?: string | null;
}

/** 2026-09-09T13:00:00.000Z → 20260909T130000Z (UTC, formato iCalendar). */
function toICSDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 5545 §3.3.11: escapar `\`, `;`, `,` y saltos de línea en TEXT. */
export function escapeICS(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * RFC 5545 §3.1: líneas de máximo 75 octetos; la continuación empieza con
 * un espacio. Contamos bytes UTF-8 (no chars) y nunca partimos un code
 * point a la mitad.
 */
export function foldICSLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // la continuación gasta 1 en el espacio
    if (currentBytes + size > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += size;
  }
  out.push(current);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n');
}

export function buildICS(p: Props): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Showly//Agendamiento//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${p.uid}`,
    `DTSTAMP:${toICSDate(new Date().toISOString())}`,
    `DTSTART:${toICSDate(p.startISO)}`,
    `DTEND:${toICSDate(p.endISO)}`,
    `SUMMARY:${escapeICS(p.title)}`,
    p.location ? `LOCATION:${escapeICS(p.location)}` : null,
    p.description ? `DESCRIPTION:${escapeICS(p.description)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((l): l is string => Boolean(l));
  return lines.map(foldICSLine).join('\r\n') + '\r\n';
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
