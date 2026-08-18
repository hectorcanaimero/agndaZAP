import Link from 'next/link';
import { cn } from '@/lib/utils';
import { APPOINTMENT_STATUS_TOKENS } from '@/components/ui/tokens';
import type { DashboardMetrics } from './types';
import { LucideIcon } from './LucideIcon';

interface Props {
  today: DashboardMetrics['today'];
  timezone: string;
  locale: string;
  labels: {
    eyebrow: string;
    description: string;
    empty: string;
    emptyHint: string;
    viewAgendaCta: string;
    progressLabel: string;
    remainingLabel: string;
    statusFilled: string;
    statusPending: string;
    with: string;
    statusText: Record<string, string>;
  };
  agendaHref: string;
  animationDelay?: number;
}

/**
 * TodayPanel — el "control tower" del día en curso.
 *
 * Layout:
 *   - Header con eyebrow + progress ring circular a la derecha (% de citas
 *     completadas hoy vs total). El ring da lectura instant de "cómo va el día".
 *   - Lista de próximas 6 citas: hora, paciente, servicio, profesional, status
 *     dot. Cada fila es tab-friendly y visualmente densa (tabular hora, texto
 *     truncado sin fantasmas de ellipsis).
 *   - CTA discreto abajo → "Ver toda la agenda".
 *
 * Empty state: si `total === 0`, mostramos ilustración textual + hint.
 */
export function TodayPanel({
  today,
  timezone,
  locale,
  labels,
  agendaHref,
  animationDelay = 0,
}: Props) {
  const completed = today.attended + today.canceled + today.noShow;
  const progressPct = today.total === 0 ? 0 : completed / today.total;
  const remaining = Math.max(0, today.total - completed);

  return (
    <section
      className="group relative flex h-full animate-fade-up flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-card-flat transition-shadow duration-300 ease-out-soft hover:shadow-card-lift"
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      <header className="flex items-center justify-between gap-4 px-5 pt-5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
            {labels.eyebrow}
          </p>
          <p className="mt-1 text-sm text-gray-600">{labels.description}</p>
        </div>
        <ProgressRing pct={progressPct} value={completed} total={today.total} />
      </header>

      {/* Micro-stats row: 3 chips numéricos con foco en lo operativo del día */}
      <div className="mt-4 grid grid-cols-3 gap-2 px-5">
        <MicroStat
          label={labels.progressLabel}
          value={completed}
          tone="teal"
        />
        <MicroStat
          label={labels.remainingLabel}
          value={remaining}
          tone="navy"
        />
        <MicroStat
          label={labels.statusText.PENDIENTE}
          value={today.pending}
          tone="amber"
        />
      </div>

      <div className="mt-4 flex-1 px-2">
        {today.upcoming.length === 0 ? (
          <EmptyState
            title={today.total === 0 ? labels.empty : labels.emptyHint}
            hint={today.total === 0 ? labels.emptyHint : undefined}
          />
        ) : (
          <ol className="divide-y divide-gray-100">
            {today.upcoming.map((appt) => (
              <li key={appt.id}>
                <AppointmentRow
                  appt={appt}
                  timezone={timezone}
                  locale={locale}
                  statusText={labels.statusText[appt.status] ?? appt.status}
                  withLabel={labels.with}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="mt-2 border-t border-gray-100 px-5 py-3">
        <Link
          href={agendaHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-navy hover:text-brand-navy/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy"
        >
          {labels.viewAgendaCta}
          <LucideIcon
            name="ArrowUpRight"
            className="h-3 w-3"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </Link>
      </footer>
    </section>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ProgressRing({
  pct,
  value,
  total,
}: {
  pct: number;
  value: number;
  total: number;
}) {
  const size = 56;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);
  const displayPct = Math.round(pct * 100);

  return (
    <div
      className="relative shrink-0"
      aria-label={`${value} de ${total} (${displayPct}%)`}
      role="img"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(0 0% 92%)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(170 71% 45%)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-gray-900 tabular-nums">
        {displayPct}%
      </span>
    </div>
  );
}

function MicroStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'teal' | 'navy' | 'amber';
}) {
  const dotColor =
    tone === 'teal'
      ? 'bg-teal-500'
      : tone === 'amber'
      ? 'bg-amber-500'
      : 'bg-brand-navy';
  return (
    <div className="rounded-lg bg-gray-50/70 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', dotColor)} aria-hidden="true" />
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-gray-500">
          {label}
        </span>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
        {value}
      </p>
    </div>
  );
}

function AppointmentRow({
  appt,
  timezone,
  locale,
  statusText,
  withLabel,
}: {
  appt: DashboardMetrics['today']['upcoming'][number];
  timezone: string;
  locale: string;
  statusText: string;
  withLabel: string;
}) {
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    hour12: false,
  }).format(new Date(appt.startAt));

  const dot = APPOINTMENT_STATUS_TOKENS[appt.status].dot;

  return (
    <div className="grid grid-cols-[52px_1fr_auto] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-gray-50/60">
      <time
        dateTime={appt.startAt}
        className="text-sm font-semibold tabular-nums text-gray-900"
      >
        {time}
      </time>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">
          {appt.patientName ?? appt.patientPhone}
        </p>
        <p className="truncate text-xs text-gray-500">
          {appt.serviceName}
          <span className="mx-1 text-gray-300">·</span>
          {withLabel} {appt.professionalName}
        </p>
      </div>
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-gray-600"
        aria-label={statusText}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden="true" />
        <span className="hidden sm:inline">{statusText}</span>
      </span>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-5 py-8 text-center">
      <LucideIcon
        name="CalendarDays"
        className="h-8 w-8 text-gray-300"
        aria-hidden="true"
      />
      <p className="mt-2 text-sm font-medium text-gray-700">{title}</p>
      {hint ? <p className="text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}
