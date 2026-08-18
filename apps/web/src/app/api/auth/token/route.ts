import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth';

// Server-side endpoint que expone el JWT al SPA leyendo la cookie desde
// `next/headers`. Se prepara para la migración a cookies HttpOnly:
// hoy el SPA lee `document.cookie` directamente (deuda del review Medio #3),
// mañana leerá desde acá.
//
// NO cambia el flow actual — es adición pura, sin ruptura. El día que
// migremos a HttpOnly, el SPA pasa de `readTokenFromDocument()` a
// `fetch('/api/auth/token')` en el bootstrap del layout.
//
// Runtime nodejs + force-dynamic: nunca cachear (respuesta depende del cookie
// del request, sería un bug catastrófico servirla desde caché).
//
// 401 con body vacío si no hay cookie — el SPA interpreta como "no logueado"
// y redirige al /login.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE_NAME)?.value;
  if (!token) {
    return new NextResponse(null, { status: 401 });
  }
  return NextResponse.json(
    { token },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}
