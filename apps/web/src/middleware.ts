import { NextRequest, NextResponse } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { AUTH_COOKIE_NAME, decodeJwtPayload } from '@/lib/auth';
import { routing } from './i18n/routing';

/**
 * Middleware combinado:
 * 1. Se aplica el middleware de next-intl para el enrutamiento con `locale`.
 * 2. Sobre las rutas del panel (`/[locale]/panel/*`), chequeamos el cookie de
 *    sesión. Si no está o expiró, redirect a `/[locale]/login`.
 *
 * NO validamos firma acá — solo `exp`. La firma la valida el backend en cada
 * request. Este check es UX puro (no dejar al recepcionista entrar sin token).
 */
const intlMiddleware = createIntlMiddleware(routing);

// Regexes derivadas de `routing.locales` — agregar un locale nuevo (ej. `en`)
// no requiere tocar este archivo. Ver Nit-N4.
const LOCALES_PATTERN = routing.locales.join('|');
const PANEL_REGEX = new RegExp(`^/(?:${LOCALES_PATTERN})/panel(?:/.*)?$`);
const LOGIN_REGEX = new RegExp(`^/(?:${LOCALES_PATTERN})/login/?$`);
const LOCALE_PREFIX_REGEX = new RegExp(`^/(${LOCALES_PATTERN})(?:/|$)`);

type Locale = (typeof routing.locales)[number];

function extractLocale(pathname: string): Locale {
  const match = pathname.match(LOCALE_PREFIX_REGEX);
  return (match?.[1] as Locale) ?? routing.defaultLocale;
}

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Guard del panel: si no hay token válido, redirect al login del mismo locale.
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
  }

  // Redirect: si ya hay sesión válida y vas a /login, mandalo al panel.
  if (LOGIN_REGEX.test(pathname)) {
    const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    const session = token ? decodeJwtPayload(token) : null;
    const isValid = session && session.exp * 1000 > Date.now();
    if (isValid) {
      const locale = extractLocale(pathname);
      const panelUrl = request.nextUrl.clone();
      panelUrl.pathname = `/${locale}/panel/dashboard`;
      panelUrl.search = '';
      return NextResponse.redirect(panelUrl);
    }
  }

  return intlMiddleware(request);
}

export const config = {
  // Matcher: todo excepto assets estáticos y rutas API.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
