import Link from 'next/link';
import { SectionCard } from './SectionCard';
import { LucideIcon } from './LucideIcon';
import type { DashboardMetrics } from './types';

interface Props {
  data: DashboardMetrics['pendingConfirmation'];
  locale: string;
  timezone: string;
  labels: {
    eyebrow: string;
    description: string;
    empty: string;
    inHours: string; // "en {h}h"
    inHoursTomorrow: string; // "mañana {time}"
    countAction: string; // "Ver todas"
    conversationsHref?: string;
    with: string;
    now: string;
  };
  animationDelay?: number;
  href?: string;
}

/**
 * PendingConfirmationPanel — foco en las citas PENDIENTE que arrancan pronto.
 *
 * Cada fila muestra:
 *   - Chip amber con "en Xh" o "mañana HH:mm" (proximidad → urgencia).
 *   - Paciente + servicio + profesional.
 *   - Un dot amber persistente que refuerza "requiere acción".
 *
 * Empty state es celebratorio ("Todo confirmado ✓") — el cero acá es bueno.
 * Muy distinto del cero en "citas hoy" (que sería malo/normal).
 */
export function PendingConfirmationPanel({
  data,
  locale,
  timezone,
  labels,
  animationDelay = 0,
  href,
}: Props) {
  const action = href && data.total > 0 ? (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
    >
      {data.total}
      <LucideIcon
        name="ArrowUpRight"
        className="h-3 w-3"
        strokeWidth={2.5}
        aria-hidden="true"
      />
    </Link>
  ) : null;

  return (
    <SectionCard
      title={labels.eyebrow}
      description={labels.description}
      icon="Clock3"
      action={action}
      animationDelay={animationDelay}
      contentClassName="!pt-3 !px-0"
    >
      {data.next.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
            <LucideIcon
              name="CheckCircle2"
              className="h-5 w-5 text-emerald-500"
              aria-hidden="true"
            />
          </div>
          <p className="text-sm font-medium text-gray-700">{labels.empty}</p>
        </div>
      ) : (
        <ol className="divide-y divide-gray-100">
          {data.next.map((row) => (
            <li key={row.id}>
              <PendingRow
                row={row}
                locale={locale}
                timezone={timezone}
                labels={labels}
              />
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function PendingRow({
  row,
  locale,
  timezone,
  labels,
}: {
  row: DashboardMetrics['pendingConfirmation']['next'][number];
  locale: string;
  timezone: string;
  labels: Props['labels'];
}) {
  const startLocal = new Date(row.startAt);
  const nowLocal = new Date();
  const sameDay =
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(startLocal) ===
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(nowLocal);

  const chipText = sameDay
    ? row.hoursUntil <= 0
      ? labels.now
      : labels.inHours.replace('{h}', String(row.hoursUntil))
    : labels.inHoursTomorrow.replace(
        '{time}',
        new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
          hour12: false,
        }).format(startLocal),
      );

  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-3 px-5 py-3 transition-colors hover:bg-gray-50/60">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 tabular-nums">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        {chipText}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">
          {row.patientName ?? row.patientPhone}
        </p>
        <p className="truncate text-xs text-gray-500">
          {row.serviceName}
          <span className="mx-1 text-gray-300">·</span>
          {labels.with} {row.professionalName}
        </p>
      </div>
    </div>
  );
}
