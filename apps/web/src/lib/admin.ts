/**
 * Cliente HTTP para el área SaaS Admin — endpoints bajo `/api/admin/*`.
 *
 * Requieren JWT con `role === 'SUPERADMIN'`. Toda mutación queda en
 * `AdminAudit` vía el interceptor del backend — el frontend no necesita
 * loggear nada extra.
 *
 * Los tipos duplican deliberadamente los shapes del backend (no importamos
 * desde `@showly/backend` para mantener el bundle del web independiente de
 * la dependencia). Los shapes vienen de:
 *   - `admin-clinics.service.ts` (`ListClinicsResult`, `GetClinicResult`)
 *   - `admin-audit.service.ts` (`ListAuditResult`)
 *   - `admin-metrics.service.ts` (`OverviewMetrics`)
 *   - `impersonation.service.ts` (`ImpersonationResult`)
 * Si divergen, TypeScript no lo detecta — mantenerlos sync a mano.
 */

/* ─────────────────────────── Types ─────────────────────────── */

export type ClinicStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export type AdminAction =
  | 'CREATE_CLINIC'
  | 'UPDATE_CLINIC'
  | 'SUSPEND_CLINIC'
  | 'REACTIVATE_CLINIC'
  | 'ARCHIVE_CLINIC'
  | 'START_IMPERSONATION';

export interface AdminClinicListItem {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  locale: string;
  status: ClinicStatus;
  /** ISO string. `null` cuando status !== SUSPENDED. */
  suspendedAt: string | null;
  _count: {
    professionals: number;
    appointments: number;
  };
}

export interface AdminClinicsListResponse {
  items: AdminClinicListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminClinicDetail {
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    locale: string;
    wahaSession: string;
    status: ClinicStatus;
    /** ISO string. `null` cuando status !== SUSPENDED. */
    suspendedAt: string | null;
    suspendedReason: string | null;
    address: string | null;
  };
  metrics: {
    professionals: number;
    servicesActive: number;
    appointmentsLast30d: number;
    /** 0..1 — el caller formatea como `%`. */
    noShowRateLast30d: number;
    patients: number;
  };
}

export interface AdminAuditRow {
  id: string;
  actorUserId: string;
  /**
   * Info del actor incluida vía `include` en el backend. En principio siempre
   * viene, pero tipamos como opcional por si un audit apunta a un user borrado.
   */
  actor?: {
    id: string;
    email: string;
    name: string;
  };
  action: AdminAction;
  targetType: string;
  targetId: string | null;
  /** Metadata JSON — shape libre por acción. */
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AdminAuditListResponse {
  items: AdminAuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Overview cross-tenant. Ver `AdminMetricsService.getOverview()`. */
export interface AdminMetricsOverview {
  clinics: {
    active: number;
    suspended: number;
    archived: number;
    total: number;
  };
  appointmentsLast30d: number;
  /** Fracción 0..1. 0 si no hay citas terminales en el período. */
  noShowRateLast30d: number;
  topClinics: Array<{
    id: string;
    name: string;
    slug: string;
    appointmentCount: number;
  }>;
}

/**
 * Body del `POST /api/admin/clinics` — matchea `CreateClinicDto` en el
 * backend. NO lleva password: el backend genera una password random, crea
 * una Invitation de 7 días y envía email al `admin.email` con link a
 * `/[locale]/invite/{token}`. El usuario elige su propia contraseña al
 * aceptar la invitación.
 */
export interface CreateClinicPayload {
  name: string;
  slug: string;
  wahaSession: string;
  timezone?: string;
  locale?: string;
  address?: string;
  admin: {
    email: string;
    name: string;
  };
}

/** Respuesta del `POST /api/admin/clinics` — `CreateClinicResult` del backend. */
export interface CreateClinicResponse {
  id: string;
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    locale: string;
    wahaSession: string;
    status: ClinicStatus;
  };
  admin: {
    id: string;
    email: string;
    name: string;
  };
  /**
   * Info de la invitación generada. El super la usa como fallback si el
   * email no llegó: puede copiar `url` y pasársela al cliente por otro
   * canal (WhatsApp, chat, etc).
   */
  invitation: {
    url: string;
    expiresAt: string; // ISO string
    emailSent: boolean;
  };
}

/**
 * Respuesta del `POST /api/admin/clinics/:id/impersonate`. El backend firma
 * un JWT temporal (30 min) con `impersonatedBy` seteado al SUPERADMIN.
 */
export interface ImpersonateResponse {
  token: string;
  /** ISO string — cuándo caduca el token temporal. */
  expiresAt: string;
  clinic: {
    id: string;
    name: string;
    slug: string;
  };
}

/* ─────────────────────────── Filters + query builders ─────────────────────────── */

export interface AdminClinicsFilters {
  status?: ClinicStatus;
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Filtros aceptados por el backend en `GET /admin/audit`. El backend NO
 * soporta rangos de fecha (`from`/`to`) — si hacen falta, agregar primero al
 * DTO del backend antes de exponerlos acá.
 */
export interface AdminAuditFilters {
  actorUserId?: string;
  action?: AdminAction;
  targetType?: string;
  targetId?: string;
  page?: number;
  pageSize?: number;
}

export function buildAdminClinicsQuery(filters: AdminClinicsFilters): string {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.search) qs.set('search', filters.search);
  if (filters.page !== undefined) qs.set('page', String(filters.page));
  if (filters.pageSize !== undefined)
    qs.set('pageSize', String(filters.pageSize));
  return qs.toString();
}

export function buildAdminAuditQuery(filters: AdminAuditFilters): string {
  const qs = new URLSearchParams();
  if (filters.actorUserId) qs.set('actorUserId', filters.actorUserId);
  if (filters.action) qs.set('action', filters.action);
  if (filters.targetType) qs.set('targetType', filters.targetType);
  if (filters.targetId) qs.set('targetId', filters.targetId);
  if (filters.page !== undefined) qs.set('page', String(filters.page));
  if (filters.pageSize !== undefined)
    qs.set('pageSize', String(filters.pageSize));
  return qs.toString();
}
