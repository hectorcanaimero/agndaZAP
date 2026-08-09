import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AgendaClient } from './AgendaClient';

function todayUTCISODate(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

interface Professional {
  id: string;
  name: string;
}

interface Appointment {
  id: string;
  startAt: string;
  endAt: string;
  status:
    | 'PENDIENTE'
    | 'CONFIRMADA'
    | 'EN_RIESGO'
    | 'ATENDIDA'
    | 'CANCELADA'
    | 'NO_SHOW';
  confirmedAt: string | null;
  canceledAt: string | null;
  outcome: string | null;
  patient: { id: string; name: string; phone: string };
  service: { id: string; name: string; durationMin: number };
  professional: { id: string; name: string };
}

/**
 * Calcula el rango que abarca la vista actual, anclado a UTC.
 *
 * - month → 42 días desde el lunes previo al día 1 del mes de `dateISO` (grid 7x6).
 *   Traemos vecinos porque el grid del calendario muestra días de meses adyacentes.
 * - week  → 7 días desde `dateISO`.
 * - day   → 1 día desde `dateISO`.
 */
/**
 * Ancla `dateISO` al anchor esperado por cada vista (mismo helper que el
 * cliente en AgendaClient.tsx — duplicado para evitar cruzar boundaries
 * server/client). Ver comentario ahí para el racional.
 */
function normalizeDateForView(
  dateISO: string,
  view: 'month' | 'week' | 'day',
): string {
  if (view === 'month') return `${dateISO.slice(0, 7)}-01`;
  if (view === 'week') {
    const [y, m, d] = dateISO.split('-').map(Number);
    const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
    const dow = new Date(ms).getUTCDay();
    const offset = (dow + 6) % 7;
    return new Date(ms - offset * 86_400_000).toISOString().slice(0, 10);
  }
  return dateISO;
}

function rangeFor(
  dateISO: string,
  view: 'month' | 'week' | 'day',
): { from: Date; to: Date } {
  if (view === 'month') {
    const [y, m] = dateISO.split('-').map(Number);
    const first = new Date(Date.UTC(y!, (m ?? 1) - 1, 1));
    const dow = first.getUTCDay(); // 0=sun ... 6=sat
    const offsetToMonday = (dow + 6) % 7;
    const from = new Date(first);
    from.setUTCDate(1 - offsetToMonday);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 42);
    return { from, to };
  }

  const from = new Date(`${dateISO}T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + (view === 'week' ? 7 : 1));
  return { from, to };
}

export default async function AgendaPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    date?: string;
    view?: string;
    professionalId?: string;
    status?: string;
    q?: string;
  }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations('panel.agenda');

  const view: 'month' | 'week' | 'day' =
    sp.view === 'week' ? 'week' : sp.view === 'day' ? 'day' : 'month';
  // Normalizamos el date para que la vista rinda desde el anchor correcto:
  //  - month → día 1 del mes
  //  - week  → LUNES de la semana que contiene la fecha
  //  - day   → tal cual
  // Así compartir una URL con date arbitrario (ej. desde otra vista) siempre
  // aterriza en un período coherente.
  const dateISO = normalizeDateForView(sp.date ?? todayUTCISODate(), view);

  const { from, to } = rangeFor(dateISO, view);

  const qs = new URLSearchParams();
  qs.set('from', from.toISOString());
  qs.set('to', to.toISOString());
  // El backend DTO limita `limit` a 200. Para vista mensual esto acota
  // clínicas grandes; si en el futuro rebalsamos hay que subir el Max en
  // `ListAppointmentsQueryDto` o paginar.
  qs.set('limit', '200');
  if (sp.professionalId) qs.set('professionalId', sp.professionalId);
  // status llega como CSV desde el cliente; el backend acepta uno solo, así
  // que sólo lo pasamos si trae exactamente un valor. El resto lo filtramos
  // client-side dentro de AgendaClient sobre el snapshot SSR.
  const statusList = (sp.status ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statusList.length === 1) qs.set('status', statusList[0]);

  const token = await getTokenFromCookies();
  const [apptsRes, profsRes] = await Promise.all([
    fetcher<Appointment[]>(`/api/appointments?${qs.toString()}`, { token }),
    fetcher<Array<{ id: string; name: string }>>('/api/professionals', {
      token,
    }),
  ]);

  const appointments = apptsRes.ok ? apptsRes.data : [];
  const professionals: Professional[] = profsRes.ok
    ? profsRes.data.map((p) => ({ id: p.id, name: p.name }))
    : [];

  return (
    <div className="w-full space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      {!apptsRes.ok ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError', { status: apptsRes.status })}
        </div>
      ) : null}

      <AgendaClient
        locale={locale}
        date={dateISO}
        view={view}
        professionalId={sp.professionalId ?? ''}
        status={sp.status ?? ''}
        query={sp.q ?? ''}
        appointments={appointments}
        professionals={professionals}
      />
    </div>
  );
}
