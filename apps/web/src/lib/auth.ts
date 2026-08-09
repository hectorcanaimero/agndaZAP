/**
 * Auth client para el panel admin de AgendaZap.
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
export const AUTH_COOKIE_NAME = 'agendazap_token';

/** Cookie válido por 24h — matchea `expiresIn` del JWT en el backend. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

export type UserRole = 'CLINIC_ADMIN' | 'PROFESSIONAL' | 'SUPERADMIN';

export interface Session {
  userId: string;
  clinicId: string | null;
  role: UserRole;
  exp: number;
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
    };
    if (!json.sub || !json.role || typeof json.exp !== 'number') return null;
    return {
      userId: json.sub,
      clinicId: json.clinicId ?? null,
      role: json.role,
      exp: json.exp,
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
 * Client-side: escribe el cookie con el token. `sameSite=Lax`, `path=/`, y
 * `Secure` en https.
 */
export function writeTokenToDocument(token: string): void {
  if (typeof document === 'undefined') return;
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? '; Secure'
      : '';
  document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(
    token,
  )}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

/**
 * Client-side: borra el cookie.
 */
export function clearTokenFromDocument(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
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

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    cache: options.cache ?? 'no-store',
  });

  // 401 client-side: token expiró/inválido → limpiar cookie y mandar al login
  // del locale actual, con `next` para volver post-login. En SSR NO redirigimos
  // (dejamos que el caller/Nest maneje según el contexto). Ver audit Nit-A1.
  if (res.status === 401 && typeof window !== 'undefined') {
    clearTokenFromDocument();
    const pathname = window.location.pathname;
    // Locale del path: 'es' o 'pt' (default 'es' si no está en la ruta).
    const localeMatch = pathname.split('/')[1];
    const locale = localeMatch === 'pt' ? 'pt' : 'es';
    window.location.href = `/${locale}/login?next=${encodeURIComponent(
      pathname,
    )}`;
    // Devolvemos algo válido, aunque el navigate ya interrumpe la ejecución.
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
