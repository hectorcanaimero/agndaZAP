import { NextRequest, NextResponse } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { AUTH_COOKIE_NAME, decodeJwtPayload } from '@/lib/auth';
import { routing } from './i18n/routing';

/**
 * Middleware combinado:
 * 1. Se aplica el middleware de next-intl para el enrutamiento con `locale`.
 * 2. Rutas del panel (`/[locale]/panel/*`): requieren sesión válida. Sin ella,
 *    redirect a login. Si el usuario es SUPERADMIN sin `impersonatedBy` (no
 *    está impersonando una clínica), se redirige al área admin en su lugar.
 * 3. Rutas del admin (`/[locale]/admin/*`): requieren `role === 'SUPERADMIN'`.
 *    Cualquier otro rol válido que intente acceder es redirigido al panel.
 * 4. Login: si hay sesión válida, redirige al destino correcto según rol.
 *
 * NO validamos firma acá — solo `exp` y claims del payload. La firma la valida
 * el backend en cada request. Este check es UX puro.
 */
const intlMiddleware = createIntlMiddleware(routing);

// Regexes derivadas de `routing.locales` — agregar un locale nuevo (ej. `en`)
// no requiere tocar este archivo. Ver Nit-N4.
const LOCALES_PATTERN = routing.locales.join('|');
const PANEL_REGEX = new RegExp(`^/(?:${LOCALES_PATTERN})/panel(?:/.*)?$`);
const ADMIN_REGEX = new RegExp(`^/(?:${LOCALES_PATTERN})/admin(?:/.*)?$`);
const LOGIN_REGEX = new RegExp(`^/(?:${LOCALES_PATTERN})/login/?$`);
const LOCALE_PREFIX_REGEX = new RegExp(`^/(${LOCALES_PATTERN})(?:/|$)`);

type Locale = (typeof routing.locales)[number];

function extractLocale(pathname: string): Locale {
  const match = pathname.match(LOCALE_PREFIX_REGEX);
  return (match?.[1] as Locale) ?? routing.defaultLocale;
}

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Guard del área admin ─────────────────────────────────────────────────
  // Solo SUPERADMIN puede entrar. Cualquier otro (o sin sesión) va al panel
  // (si tiene sesión) o al login (si no la tiene).
  if (ADMIN_REGEX.test(pathname)) {
    const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    const session = token ? decodeJwtPayload(token) : null;
    const isValid = session && session.exp * 1000 > Date.now();

    if (!isValid) {
      const locale = extractLocale(pathname);
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = `/${locale}/login`;
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }

    if (session.role !== 'SUPERADMIN') {
      const locale = extractLocale(pathname);
      const panelUrl = request.nextUrl.clone();
      panelUrl.pathname = `/${locale}/panel/dashboard`;
      panelUrl.search = '';
      return NextResponse.redirect(panelUrl);
    }
  }

  // ── Guard del panel de clínica ───────────────────────────────────────────
  // 1. Sin sesión → login.
  // 2. SUPERADMIN sin impersonatedBy → redirect al área admin (no tiene clínica).
  // 3. SUPERADMIN con impersonatedBy → acceso permitido (está impersonando).
  // 4. Otros roles válidos → acceso normal.
  if (PANEL_REGEX.test(pathname)) {
    const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    const session = token ? decodeJwtPayload(token) : null;
    const isValid = session && session.exp * 1000 > Date.now();

    if (!isValid) {
      const locale = extractLocale(pathname);
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = `/${locale}/login`;
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // SUPERADMIN sin impersonación no tiene contexto de clínica.
    if (session.role === 'SUPERADMIN' && !session.impersonatedBy) {
      const locale = extractLocale(pathname);
      const adminUrl = request.nextUrl.clone();
      adminUrl.pathname = `/${locale}/admin/dashboard`;
      adminUrl.search = '';
      return NextResponse.redirect(adminUrl);
    }
  }

  // ── Redirect desde login si ya hay sesión ───────────────────────────────
  // SUPERADMIN va al área admin; el resto va al panel de su clínica.
  if (LOGIN_REGEX.test(pathname)) {
    const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    const session = token ? decodeJwtPayload(token) : null;
    const isValid = session && session.exp * 1000 > Date.now();

    if (isValid) {
      const locale = extractLocale(pathname);
      const destUrl = request.nextUrl.clone();
      destUrl.search = '';
      if (session.role === 'SUPERADMIN' && !session.impersonatedBy) {
        destUrl.pathname = `/${locale}/admin/dashboard`;
      } else {
        destUrl.pathname = `/${locale}/panel/dashboard`;
      }
      return NextResponse.redirect(destUrl);
    }
  }

  return intlMiddleware(request);
}

export const config = {
  // Matcher: todo excepto assets estáticos y rutas API.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
