/**
 * Validación fail-fast del entorno en producción. Función pura (recibe el
 * env como argumento) para poder testearla sin tocar `process.env`.
 *
 * Devuelve la lista de errores; `main.ts` lanza si no está vacía.
 */
export type EnvLike = Record<string, string | undefined>;

/** Env vars que en producción tienen que existir sí o sí. */
export const REQUIRED_PROD_ENV = [
  'DATABASE_URL',
  'REDIS_URL',
  'WAHA_BASE_URL',
  'WAHA_API_KEY',
  // Sin whitelist explícita `enableCors` bloquea todo lo cross-origin.
  'CORS_ORIGINS',
  // Sin JWT_SECRET no podemos firmar tokens.
  'JWT_SECRET',
  // Sin Sentry quedamos ciegos frente a errores en producción.
  'SENTRY_DSN',
] as const;

export function getRequiredProdEnv(): readonly string[] {
  return REQUIRED_PROD_ENV;
}

export function validateProdEnv(env: EnvLike): string[] {
  const errors: string[] = [];

  const missing = REQUIRED_PROD_ENV.filter((k) => !env[k]);
  if (missing.length) {
    errors.push(`Faltan env vars en producción: ${missing.join(', ')}`);
  }

  // JWT_SECRET: no basta con "existe", tiene que ser SUFICIENTEMENTE FUERTE.
  // - `< 32 chars` → HS256 pierde entropía útil. Recomendado 48+ bytes base64.
  // - `startsWith('dev-')` → el default del repo; en prod es error fatal.
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret && jwtSecret.length < 32) {
    errors.push('JWT_SECRET debe tener al menos 32 caracteres en producción');
  }
  if (jwtSecret.startsWith('dev-')) {
    errors.push('JWT_SECRET no puede tener prefijo "dev-" en producción');
  }

  // Auth del webhook WAHA. Semántica de `verifyWebhookAuth` (webhook-auth.util):
  // HMAC > token > skip explícito, y el skip (ALLOW_WEBHOOK_WITHOUT_TOKEN)
  // NUNCA aplica en prod. Por eso acá exigimos al menos UNO de los dos
  // secretos: si faltan ambos, el backend arrancaría y rechazaría con 403
  // todos los webhooks (bot muerto en silencio). Si hay HMAC, el token es
  // opcional (el util ni lo mira). ALLOW_WEBHOOK_WITHOUT_TOKEN=true en prod
  // es un error de config: no relaja nada y esconde el olvido.
  if (!env.WEBHOOK_HMAC_SECRET && !env.WEBHOOK_TOKEN) {
    errors.push(
      'WEBHOOK_HMAC_SECRET o WEBHOOK_TOKEN son obligatorios en producción',
    );
  }
  if (env.ALLOW_WEBHOOK_WITHOUT_TOKEN === 'true') {
    errors.push(
      'ALLOW_WEBHOOK_WITHOUT_TOKEN=true no está permitido en producción (se ignora en el webhook y esconde la falta de secreto)',
    );
  }

  return errors;
}
