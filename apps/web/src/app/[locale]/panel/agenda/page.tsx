import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetcher, getTokenFromCookies } from '@/lib/auth';
import { AgendaClient } from './AgendaClient';

/**
 * Formatea una Date UTC como `YYYY-MM-DD` en la zona UTC. Nos alcanza para
 * anchor de rango en la agenda; la TZ de la clínica se aplica más tarde en el
 * render de horarios (el backend guarda UTC, el frontend formatea con Intl).
 */
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
 * NOTA sobre la ventana temporal:
 * El backend acepta `from`/`to` en ISO. Enviamos el rango con Luxon en UTC
 * (el server no conoce la TZ del usuario en SSR; la TZ real es la de la
 * clínica y el filtro por `startAt >= from` sigue siendo correcto porque
 * `startAt` es UTC).
 *
 * `view=day` → rango de 24h alrededor de `date`.
 * `view=week` → rango de 7 días desde `date`.
 */
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
  }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations('panel.agenda');

  const view = sp.view === 'week' ? 'week' : 'day';
  const dateISO = sp.date ?? todayUTCISODate();
  // Anchor UTC 00:00 → +1 día (o +7 en week). El backend valida `startAt >= from`
  // usando UTC — es equivalente al día completo desde la perspectiva del cliente.
  const from = new Date(`${dateISO}T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + (view === 'week' ? 7 : 1));

  const qs = new URLSearchParams();
  qs.set('from', from.toISOString());
  qs.set('to', to.toISOString());
  qs.set('limit', '200');
  if (sp.professionalId) qs.set('professionalId', sp.professionalId);
  if (sp.status) qs.set('status', sp.status);

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
    <div className="max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500">{t('subtitle')}</p>
        </div>
      </div>

      {!apptsRes.ok ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {t('loadError', { status: apptsRes.status })}
        </div>
      ) : null}

      <AgendaClient
        locale={locale}
        date={dateISO}
        view={view}
        professionalId={sp.professionalId ?? ''}
        status={sp.status ?? ''}
        appointments={appointments}
        professionals={professionals}
      />
    </div>
  );
}
