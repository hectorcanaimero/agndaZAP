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
  /**
   * WhatsApp de la clínica en E.164 (`+...`) para el link `wa.me` de /gracias.
   * `null` si la clínica no lo configuró (opt-in en /panel/ajustes).
   */
  whatsappPhone: string | null;
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
  /**
   * Token de sesión del link WA (opcional). Cuando viene, el backend consume
   * el token, valida que el `clinicSlug` matchee la URL y ata la cita a la
   * `Conversation` origen. Si el token expiró/es inválido → 400.
   */
  token?: string;
}

/**
 * Datos que el backend devuelve al hidratar el link `?t=<token>`.
 *
 * - `phoneEditable`: `false` cuando el bot ya conoce el teléfono del paciente
 *   (Conversation WA con chatId `@c.us`) — el form lo muestra readonly para no
 *   romper el linkeo WA↔cita. `true` cuando la conversación es `@lid` sin
 *   phone resuelto — el form pide el teléfono como required editable.
 */
export interface SchedulingSession {
  clinicSlug: string;
  name: string | null;
  phone: string | null;
  phoneEditable: boolean;
}

/**
 * Hidrata la sesión de agendamiento desde un token WA. Devuelve `null` si el
 * token no existe o expiró (404). El caller decide si abortar el prefill y
 * mostrar un aviso "tu link expiró".
 *
 * NO consume el token — eso pasa recién en `createAppointment`. El usuario
 * puede recargar el form las veces que quiera.
 */
export async function fetchSchedulingSession(
  token: string,
): Promise<SchedulingSession | null> {
  const res = await fetch(
    `${API_URL}/api/public/scheduling/session/${encodeURIComponent(token)}`,
    { cache: 'no-store' },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchSchedulingSession failed: ${res.status}`);
  }
  return res.json();
}

export interface CreateAppointmentResult {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  /**
   * Link de gestión de la cita. **Opcional**: si Redis está caído el backend
   * no emite el token pero crea la cita igual. El caller tiene que tratar su
   * ausencia como normal y simplemente no ofrecer el bloque de gestión.
   */
  manageUrl?: string;
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

/* ─────────────────── Gestión de cita por link (M2) ─────────────────── */

/**
 * Cita tal como la devuelve el endpoint de gestión. `startAtISO` viene con
 * zona explícita; se formatea siempre con `clinic.timezone`, nunca con la del
 * navegador.
 */
/** Espejo del enum `AppointmentStatus` de Prisma. */
export type AppointmentStatus =
  | 'PENDIENTE'
  | 'CONFIRMADA'
  | 'EN_RIESGO'
  | 'ATENDIDA'
  | 'CANCELADA'
  | 'NO_SHOW';

export interface ManagedAppointment {
  id: string;
  serviceId: string;
  serviceName: string;
  professionalId: string;
  professionalName: string;
  startAtISO: string;
  durationMin: number;
  status: AppointmentStatus;
  /**
   * Reagendamientos hechos **por el paciente**. Los movimientos que hace
   * recepción desde el panel no cuentan aquí. Opcional: el backend lo añadió
   * después del contrato inicial, así que la web no puede darlo por seguro.
   */
  rescheduleCount?: number;
}

/**
 * Respuesta del `GET manage/:token`.
 *
 * De `patient` llega **sólo el nombre**, nunca el teléfono: el link puede
 * acabar reenviado por WhatsApp a un tercero, y el nombre alcanza para que el
 * paciente reconozca que la cita es suya.
 *
 * `canCancel`/`canReschedule` son una pista para la UI, **no una garantía**:
 * la clínica puede marcar la cita ATENDIDA entre que se pinta la página y el
 * clic, así que las acciones tienen que manejar el 409 igual.
 */
export interface ManagedAppointmentData {
  appointment: ManagedAppointment;
  clinic: {
    name: string;
    address: string | null;
    timezone: string;
    locale: string;
  };
  patient: { name: string };
  canCancel: boolean;
  canReschedule: boolean;
}

/**
 * Código de error estable del backend. El `message` se reescribe a menudo (por
 * tono o por traducción), así que distinguir casos por el texto es frágil.
 * Opcional: un backend anterior a #73 no lo manda.
 */
export type ManageErrorCode = 'RESCHEDULE_LIMIT' | 'SLOT_TAKEN';

export type ManageActionResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; code?: ManageErrorCode };

function manageUrlFor(slug: string, token: string, suffix = ''): string {
  return `${API_URL}/api/public/clinics/${encodeURIComponent(
    slug,
  )}/appointments/manage/${encodeURIComponent(token)}${suffix}`;
}

/**
 * Hidrata la página de gestión. Devuelve `null` ante un 404.
 *
 * El backend responde **el mismo 404 para todos los fallos de token**
 * (expirado, de otra clínica, cita borrada) a propósito: no le confirma nada a
 * quien prueba tokens. Por eso el front no puede ni debe intentar distinguir
 * el motivo — una sola pantalla de "este link ya no vale".
 */
export async function fetchManagedAppointment(
  slug: string,
  token: string,
): Promise<ManagedAppointmentData | null> {
  const res = await fetch(manageUrlFor(slug, token), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchManagedAppointment failed: ${res.status}`);
  }
  return res.json();
}

async function postManage<T>(
  url: string,
  body?: unknown,
): Promise<ManageActionResponse<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }

  if (res.ok) return { ok: true, data: parsed as T };
  const err = parsed as { message?: string; code?: ManageErrorCode } | null;
  const message = err?.message ?? `HTTP ${res.status}`;
  return {
    ok: false,
    status: res.status,
    message,
    ...(err?.code ? { code: err.code } : {}),
  };
}

export async function cancelManagedAppointment(
  slug: string,
  token: string,
): Promise<ManageActionResponse<{ status: AppointmentStatus }>> {
  return postManage(manageUrlFor(slug, token, '/cancel'));
}

/**
 * Mueve la cita. **Es in-place: `appointment.id` NO cambia** — el backend no
 * crea una fila nueva, porque una CANCELADA por reagendamiento diluiría el
 * no-show rate, que es la métrica estrella del producto. Por eso el éxito se
 * detecta por el 200 y el nuevo `startAtISO`, nunca comparando ids.
 *
 * La cita vuelve a `PENDIENTE` (el backend limpia `confirmedAt`): moverla
 * invalida la confirmación anterior, así que el estado que devuelve NO es el
 * que tenía antes.
 *
 * `manageUrl` es **opcional**: si Redis falla no se emite token nuevo, pero la
 * cita se movió igual (preferimos perder el link antes que la cita).
 */
export async function rescheduleManagedAppointment(
  slug: string,
  token: string,
  startAtISO: string,
): Promise<
  ManageActionResponse<{
    appointment: ManagedAppointment;
    manageUrl?: string;
    /**
     * Estado del cupo **después** de este movimiento, para no tener que pedir
     * otra vez el GET sólo para saber si al paciente le queda algún cambio.
     * Opcionales: llegaron después del contrato inicial.
     */
    rescheduleCount?: number;
    canReschedule?: boolean;
  }>
> {
  return postManage(manageUrlFor(slug, token, '/reschedule'), { startAtISO });
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
