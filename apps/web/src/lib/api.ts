/**
 * Cliente HTTP hacia el backend NestJS.
 *
 * Convención: `NEXT_PUBLIC_API_URL` (default: `http://localhost:4000`).
 * En el server (SSR) usamos fetch nativo con `cache: 'no-store'` para no
 * cachear datos que dependen de disponibilidad en tiempo real.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface PublicClinic {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  timezone: string;
  locale: string;
  services: Array<{
    id: string;
    name: string;
    durationMin: number;
    priceCents: number | null;
  }>;
  professionals: Array<{
    id: string;
    name: string;
    serviceIds: string[];
  }>;
}

export interface Slot {
  startAt: string; // ISO 8601
  endAt: string;
}

/**
 * Trae el snapshot público de la clínica. Devuelve `null` si el backend
 * responde 404 (permite al caller decidir mostrar `notFound()`).
 *
 * Nota defensa-en-profundidad: envolvemos `slug` con `encodeURIComponent`. Next
 * ya decodea path segments por default, pero un slug con caracteres raros no
 * debería romper la URL final que arma `fetch`. El backend además valida el
 * slug contra `^[a-z0-9-]{1,50}$` vía `SlugValidationPipe`.
 */
export async function fetchClinic(slug: string): Promise<PublicClinic | null> {
  const res = await fetch(
    `${API_URL}/api/public/clinics/${encodeURIComponent(slug)}`,
    { cache: 'no-store' },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchClinic failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchAvailability(
  slug: string,
  params: {
    serviceId: string;
    professionalId: string;
    from: string;
    days?: number;
  },
): Promise<Slot[]> {
  const qs = new URLSearchParams({
    serviceId: params.serviceId,
    professionalId: params.professionalId,
    from: params.from,
    days: String(params.days ?? 7),
  });
  const res = await fetch(
    `${API_URL}/api/public/clinics/${encodeURIComponent(slug)}/availability?${qs.toString()}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    throw new Error(`fetchAvailability failed: ${res.status}`);
  }
  const data = (await res.json()) as Array<{ startAt: string; endAt: string }>;
  return data;
}

export interface CreateAppointmentPayload {
  phone: string;
  name: string;
  notes?: string;
  consent: boolean;
  serviceId: string;
  professionalId: string;
  startAtISO: string;
  honeypot?: string;
}

export interface CreateAppointmentResult {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
}

export type CreateAppointmentResponse =
  | { ok: true; data: CreateAppointmentResult }
  | { ok: false; status: number; message: string };

/**
 * Envía la creación de cita. Devuelve un discriminated union para que el
 * caller maneje explícitamente los códigos importantes (409/429/400) sin
 * try/catch inflado.
 */
export async function createAppointment(
  slug: string,
  payload: CreateAppointmentPayload,
): Promise<CreateAppointmentResponse> {
  const res = await fetch(
    `${API_URL}/api/public/clinics/${encodeURIComponent(slug)}/appointments`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 201 || res.status === 200) {
    return { ok: true, data: body as CreateAppointmentResult };
  }

  const message =
    (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
  return { ok: false, status: res.status, message };
}

/* ─────────────────────────── Leads (panel admin) ─────────────────────────── */

/** Status del funnel de leads — matchea `LeadStatus` en Prisma. */
export type LeadStatus = 'NEW' | 'CONTACTED' | 'DEMO' | 'CONVERTED' | 'LOST';

/**
 * Row de `Lead` como lo expone el backend en `GET /api/leads`.
 *
 * IMPORTANTE: `createdAt` viaja como string (JSON no serializa Date), NO
 * como `Date`. El caller lo parsea con `new Date(...)` en el momento de
 * formatear. Mantener este tipo sync con `model Lead` en
 * `apps/backend/prisma/schema.prisma`.
 */
export interface Lead {
  id: string;
  name: string;
  phone: string;
  clinicType: string | null;
  notes: string | null;
  source: string;
  locale: string;
  ip: string | null;
  userAgent: string | null;
  status: LeadStatus;
  contactedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadsListResponse {
  items: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Params opcionales del listado admin. `page`/`pageSize` se serializan como
 * string en la URL (query params). El backend valida rangos y tira 400 si
 * son inválidos.
 */
export interface FetchLeadsParams {
  status?: LeadStatus;
  page?: number;
  pageSize?: number;
}

/**
 * Construye el querystring canonical de `/api/leads`. Extraído para reusar
 * el mismo shape en el server component (initial fetch) y el client (useQuery).
 */
export function buildLeadsQueryString(params: FetchLeadsParams): string {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.pageSize !== undefined)
    qs.set('pageSize', String(params.pageSize));
  return qs.toString();
}
