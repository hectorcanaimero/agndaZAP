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

/** Prefijos de los placeholders del repo (`.env.example`, defaults de dev). */
const PLACEHOLDER_PREFIXES = ['dev-', 'cambiar-'] as const;

/**
 * Un secreto presente tiene que ser SUFICIENTEMENTE FUERTE, no sólo existir.
 * - `< 32 chars` → poca entropía (HS256 / HMAC). Recomendado 48+ bytes base64.
 * - prefijo `dev-` / `cambiar-` → placeholder del repo que nadie rotó.
 * Devuelve los errores del secreto `name`; vacío si no está seteado (la
 * obligatoriedad se chequea aparte).
 */
function checkSecretStrength(name: string, value: string | undefined): string[] {
  if (!value) return [];
  const errors: string[] = [];
  if (value.length < 32) {
    errors.push(`${name} debe tener al menos 32 caracteres en producción`);
  }
  const placeholder = PLACEHOLDER_PREFIXES.find((p) => value.startsWith(p));
  if (placeholder) {
    errors.push(
      `${name} no puede tener prefijo "${placeholder}" en producción`,
    );
  }
  return errors;
}

export function validateProdEnv(env: EnvLike): string[] {
  const errors: string[] = [];

  const missing = REQUIRED_PROD_ENV.filter((k) => !env[k]);
  if (missing.length) {
    errors.push(`Faltan env vars en producción: ${missing.join(', ')}`);
  }

  errors.push(...checkSecretStrength('JWT_SECRET', env.JWT_SECRET));

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
  errors.push(...checkSecretStrength('WEBHOOK_TOKEN', env.WEBHOOK_TOKEN));
  errors.push(
    ...checkSecretStrength('WEBHOOK_HMAC_SECRET', env.WEBHOOK_HMAC_SECRET),
  );
  if (env.ALLOW_WEBHOOK_WITHOUT_TOKEN === 'true') {
    errors.push(
      'ALLOW_WEBHOOK_WITHOUT_TOKEN=true no está permitido en producción (se ignora en el webhook y esconde la falta de secreto)',
    );
  }

  return errors;
}
