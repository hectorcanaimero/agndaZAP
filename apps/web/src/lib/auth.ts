/**
 * Auth client para el panel admin de Showly.
 *
 * Deuda documentada (MVP):
 * - El JWT vive en un cookie no-httpOnly. Motivo: el SPA cliente necesita leer
 *   el token para inyectarlo en `Authorization: Bearer`. Migración post-piloto:
 *   cookies httpOnly + refresh tokens vía NextAuth o handler propio.
 * - Decodificamos el JWT client/server-side SIN validar firma (solo para UI).
 *   El backend re-valida firma en cada request. Nunca confiar en el payload
 *   local para autorizar acciones sensibles.
 */
import { API_URL } from './api';

/** Nombre del cookie donde vive el accessToken. */
export const AUTH_COOKIE_NAME = 'showly_token';

/**
 * Nombre del cookie donde el frontend hace backup del JWT del SUPERADMIN
 * mientras dura una sesión de impersonation.
 *
 * Flujo:
 * - Antes de impersonar: `showly_token` = super_jwt. `showly_admin_token` no existe.
 * - Al impersonar: `showly_admin_token` = super_jwt (backup) y `showly_token` = imp_jwt (30 min).
 * - Al volver al admin: `showly_token` = super_jwt (restaurado) y `showly_admin_token` se borra.
 *
 * Solo lo maneja el cliente — el backend no lo lee.
 */
export const AUTH_ADMIN_BACKUP_COOKIE_NAME = 'showly_admin_token';

/** Cookie válido por 24h — matchea `expiresIn` del JWT en el backend. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

export type UserRole = 'CLINIC_ADMIN' | 'PROFESSIONAL' | 'SUPERADMIN';

export interface Session {
  userId: string;
  clinicId: string | null;
  role: UserRole;
  exp: number;
  /**
   * Presente solo cuando un SUPERADMIN está impersonando una clínica.
   * Contiene el `userId` del super que inició la impersonación.
   * Cuando este claim está activo, `clinicId` es el de la clínica impersonada
   * y el SUPERADMIN tiene acceso al panel de clínica normalmente.
   *
   * Fase 11 implementa la emisión de este claim en el backend y el banner
   * de "Impersonando clínica X" en el front. Por ahora solo se tipea.
   */
  impersonatedBy?: string;
}

export interface AuthMe {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    locale: string;
  } | null;
  /**
   * Solo presente cuando la sesión activa es un JWT impersonado emitido por
   * `POST /admin/clinics/:id/impersonate`. Contiene el `userId` del SUPERADMIN
   * que inició la impersonación. El `PanelShell` lo usa para renderizar el
   * `ImpersonationBanner`.
   */
  impersonatedBy?: string | null;
}

/**
 * Decodifica el payload de un JWT (base64url). NO valida la firma — sólo
 * extrae los claims para consumo de UI. Nunca autorizar operaciones sensibles
 * con esto.
 */
export function decodeJwtPayload(token: string): Session | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    // Base64URL → base64 estándar antes de decodificar.
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const decoded =
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
    const json = JSON.parse(decoded) as {
      sub?: string;
      clinicId?: string | null;
      role?: UserRole;
      exp?: number;
      impersonatedBy?: string;
    };
    if (!json.sub || !json.role || typeof json.exp !== 'number') return null;
    return {
      userId: json.sub,
      clinicId: json.clinicId ?? null,
      role: json.role,
      exp: json.exp,
      ...(json.impersonatedBy ? { impersonatedBy: json.impersonatedBy } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Chequea si el token expiró (con margen de 5 segundos para clock skew).
 */
function isExpired(session: Session): boolean {
  return session.exp * 1000 <= Date.now() + 5000;
}

/**
 * Client-side: lee el cookie del document. Devuelve `null` en SSR.
 */
export function readTokenFromDocument(): string | null {
  if (typeof document === 'undefined') return null;
  const raw = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (!raw) return null;
  const value = raw.slice(AUTH_COOKIE_NAME.length + 1);
  return decodeURIComponent(value);
}

/**
 * Client-side: escribe el cookie con el token. `SameSite=Strict`, `path=/`, y
 * `Secure` en https.
 *
 * DEUDA POST-PILOTO (ADR 0017): migrar a `HttpOnly` con refresh flow —
 * hoy el JWT queda expuesto a XSS. `SameSite=Strict` reduce CSRF pero
 * NO mitiga XSS. Ver `docs/notas/2026-08-19-observabilidad-implementada.md`
 * §deuda-post-piloto para el plan de migración (2-3 días dedicados).
 */
export function writeTokenToDocument(token: string): void {
  if (typeof document === 'undefined') return;
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? '; Secure'
      : '';
  document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(
    token,
  )}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Strict${secure}`;
}

/**
 * Client-side: borra el cookie.
 */
export function clearTokenFromDocument(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0; SameSite=Strict`;
}

/**
 * Client-side: lee el cookie con el JWT de backup del SUPERADMIN (si existe).
 * Se usa para restaurar la sesión original al terminar la impersonation o al
 * detectar que el JWT impersonado expiró.
 */
export function readAdminBackupFromDocument(): string | null {
  if (typeof document === 'undefined') return null;
  const raw = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${AUTH_ADMIN_BACKUP_COOKIE_NAME}=`));
  if (!raw) return null;
  return decodeURIComponent(raw.slice(AUTH_ADMIN_BACKUP_COOKIE_NAME.length + 1));
}

/** Client-side: guarda el backup del token de SUPERADMIN. */
export function writeAdminBackupToDocument(token: string): void {
  if (typeof document === 'undefined') return;
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? '; Secure'
      : '';
  document.cookie = `${AUTH_ADMIN_BACKUP_COOKIE_NAME}=${encodeURIComponent(
    token,
  )}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Strict${secure}`;
}

/** Client-side: borra el backup del token de SUPERADMIN. */
export function clearAdminBackupFromDocument(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${AUTH_ADMIN_BACKUP_COOKIE_NAME}=; path=/; max-age=0; SameSite=Strict`;
}

/**
 * Client-side: inicia una sesión de impersonation.
 * 1. Guarda el token actual del SUPERADMIN como backup.
 * 2. Sobrescribe el token activo con el JWT temporal recibido del backend.
 *
 * El caller (típicamente el botón "Entrar como esta clínica") se encarga del
 * redirect a `/panel/dashboard` después de llamar a esta función.
 */
export function startImpersonation(impersonationToken: string): void {
  if (typeof document === 'undefined') return;
  const currentToken = readTokenFromDocument();
  if (!currentToken) {
    throw new Error('startImpersonation: no hay sesión activa que respaldar');
  }
  writeAdminBackupToDocument(currentToken);
  writeTokenToDocument(impersonationToken);
}

/**
 * Client-side: termina la impersonation y restaura la sesión del SUPERADMIN.
 * Redirige a `/[locale]/admin/dashboard`. Si no hay backup, cae al login
 * (edge case: cookie de backup expirada o borrada manualmente).
 */
export function endImpersonation(locale: string): void {
  if (typeof document === 'undefined') return;
  const backup = readAdminBackupFromDocument();
  if (!backup) {
    // Sin backup no podemos restaurar; limpiamos todo y vamos al login.
    clearTokenFromDocument();
    if (typeof window !== 'undefined') {
      window.location.href = `/${locale}/login`;
    }
    return;
  }
  writeTokenToDocument(backup);
  clearAdminBackupFromDocument();
  if (typeof window !== 'undefined') {
    window.location.href = `/${locale}/admin/dashboard`;
  }
}

/**
 * Server-side: lee la sesión del cookie usando `next/headers`. Sólo válida
 * para Server Components / Server Actions / Route Handlers.
 */
export async function getSession(): Promise<Session | null> {
  // Import dinámico para evitar que el bundler tire el server-only code al cliente.
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const raw = store.get(AUTH_COOKIE_NAME)?.value;
  if (!raw) return null;
  const session = decodeJwtPayload(raw);
  if (!session) return null;
  if (isExpired(session)) return null;
  return session;
}

/**
 * Server-side: devuelve el token crudo del cookie. Útil para pasar a fetchers.
 */
export async function getTokenFromCookies(): Promise<string | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  return store.get(AUTH_COOKIE_NAME)?.value ?? null;
}

export interface LoginResponse {
  ok: boolean;
  status: number;
  message?: string;
}

/**
 * Client-side: pega a `/api/auth/login`. En éxito, guarda el token en el
 * cookie. En error, devuelve el status para que el caller muestre el mensaje
 * correcto.
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  try {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (res.ok) {
      const body = (await res.json()) as { accessToken?: string };
      if (!body.accessToken) {
        return { ok: false, status: 500, message: 'accessToken faltante' };
      }
      writeTokenToDocument(body.accessToken);
      return { ok: true, status: res.status };
    }

    return { ok: false, status: res.status };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      message: (e as Error).message ?? 'network error',
    };
  }
}

/**
 * Client-side: borra el cookie y redirige a `/[locale]/login`.
 */
export function logout(locale: string): void {
  clearTokenFromDocument();
  if (typeof window !== 'undefined') {
    window.location.href = `/${locale}/login`;
  }
}

/**
 * Wrapper de fetch que inyecta `Authorization: Bearer <token>`.
 *
 * - Server: lee el token desde `next/headers`.
 * - Client: lee el token desde `document.cookie`.
 *
 * `path` debe incluir el prefijo `/api/...` (ej: `/api/services`).
 * En caso de 401, sugiere al caller redirigir a login — no lo hacemos acá
 * porque no siempre estamos en un contexto de navegación.
 */
export interface FetcherOptions extends RequestInit {
  /** Token explícito (útil en Server Components ya que el cookie no viaja auto). */
  token?: string | null;
}

export async function fetcher<T = unknown>(
  path: string,
  options: FetcherOptions = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  let token = options.token ?? null;
  if (!token) {
    if (typeof window === 'undefined') {
      token = await getTokenFromCookies();
    } else {
      token = readTokenFromDocument();
    }
  }

  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  // Envolvemos el `fetch` en try/catch para transformar network errors
  // (backend caído, DNS, timeout) en un `{ ok:false, status:0 }` uniforme.
  // Sin esto la excepción propaga y — cuando el caller es un server component
  // — Next 15 renderiza el error boundary, lo que interactúa mal con el
  // middleware y puede desembocar en un loop de redirects entre `/admin` y
  // `/login`. Con `status:0` el caller decide qué hacer (typicamente:
  // seguir con datos vacíos, no redirigir).
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      cache: options.cache ?? 'no-store',
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      message: (e as Error).message ?? 'network error',
    };
  }

  // 401 client-side: token expiró/inválido. Dos flujos:
  // (a) Si hay `showly_admin_token` (sesión de impersonation activa cuyo
  //     JWT temporal caducó): restaurar la sesión del SUPERADMIN y redirigir
  //     al `/admin/dashboard` con `?imp=expired` para que el layout muestre
  //     un toast. Evita mandar al super al login cada 30 min.
  // (b) Sin backup: sesión normal expirada → login con `next=<pathname>`.
  if (res.status === 401 && typeof window !== 'undefined') {
    const pathname = window.location.pathname;
    const localeMatch = pathname.split('/')[1];
    const locale = localeMatch === 'pt' ? 'pt' : 'es';

    const backup = readAdminBackupFromDocument();
    if (backup) {
      writeTokenToDocument(backup);
      clearAdminBackupFromDocument();
      window.location.href = `/${locale}/admin/dashboard?imp=expired`;
      return { ok: false, status: 401, message: 'impersonation expirada' };
    }

    clearTokenFromDocument();
    window.location.href = `/${locale}/login?next=${encodeURIComponent(
      pathname,
    )}`;
    return { ok: false, status: 401, message: 'sesión expirada' };
  }

  if (res.status === 204) {
    return { ok: true, data: undefined as T };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok) {
    return { ok: true, data: body as T };
  }

  const message =
    (body as { message?: string | string[] } | null)?.message !== undefined
      ? Array.isArray((body as { message: string[] }).message)
        ? (body as { message: string[] }).message.join(', ')
        : String((body as { message: string }).message)
      : `HTTP ${res.status}`;

  return { ok: false, status: res.status, message };
}
