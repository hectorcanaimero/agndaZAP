import { NextResponse } from 'next/server';

// Health endpoint del frontend Next.js.
//
// Uso: Docker healthcheck + BetterStack Uptime monitor. Confirma que el
// server Next está sirviendo requests. NO verifica si el backend está vivo
// — eso lo hace un monitor separado sobre /api/health del backend, así
// distinguimos "web caído" vs "backend caído".
//
// Público (sin auth). Middleware de Next NO aplica auth a /api/health
// porque el matcher del middleware excluye estas rutas.
//
// `runtime = 'nodejs'` explícito: no queremos que corra en edge (algunas
// versiones de Vercel fuerzan edge default para route handlers cortos).
// Con Node runtime el behavior es predictible entre local, docker, y
// cualquier deploy target.
//
// `dynamic = 'force-dynamic'`: nunca cachear la respuesta — un health check
// cacheado sería un bug catastrófico (BetterStack vería "ok" para siempre).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      timestamp: new Date().toISOString(),
      // Build ID inyectado en build time (opcional). Útil para verificar
      // que el deploy real está sirviendo el commit correcto.
      buildId: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'dev',
    },
    {
      status: 200,
      headers: {
        // Nunca cachear. Explícito además del force-dynamic.
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
