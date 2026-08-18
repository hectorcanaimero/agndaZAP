import { NextResponse, type NextRequest } from 'next/server';
import { routing } from '@/i18n/routing';
import {
  AUTH_ADMIN_BACKUP_COOKIE_NAME,
  AUTH_COOKIE_NAME,
} from '@/lib/auth';

/**
 * Route handler que limpia las cookies de sesión server-side y redirige.
 *
 * Motivo: en Next 15 los server components de layout/page pueden LEER
 * cookies pero no SETEARLAS ni BORRARLAS — eso solo se puede desde route
 * handlers o server actions. Sin este endpoint, cuando un layout detecta
 * que el backend rechazó el token (401 en `/api/auth/me`) su única opción
 * es `redirect('/login')`, pero el middleware — que solo valida la cookie
 * por `exp` local, no contra la firma del backend — la sigue considerando
 * "válida" y redirige de vuelta al panel. Resultado: ERR_TOO_MANY_REDIRECTS.
 *
 * Este handler rompe el ciclo: borra ambas cookies (la principal y el
 * backup de impersonation) y redirige al `next` recibido por query — típico
 * `/es/login`. En la próxima navegación al login, el middleware ya no ve
 * cookie y no redirige.
 *
 * Query params:
 * - `next`: path relativo de destino (default `/{defaultLocale}/login`).
 *   Solo se aceptan paths que empiecen con `/` para evitar open-redirect.
 */
export function GET(req: NextRequest): NextResponse {
  const rawNext = req.nextUrl.searchParams.get('next');
  const fallback = `/${routing.defaultLocale}/login`;

  // Whitelist mínima: solo paths relativos internos. Nunca URLs absolutas
  // (bloquea open-redirect si un atacante arma un link
  // `/api/auth/force-logout?next=https://evil`).
  const next =
    rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
      ? rawNext
      : fallback;

  const dest = new URL(next, req.nextUrl.origin);
  const res = NextResponse.redirect(dest);
  res.cookies.delete(AUTH_COOKIE_NAME);
  res.cookies.delete(AUTH_ADMIN_BACKUP_COOKIE_NAME);
  return res;
}
