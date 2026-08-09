/**
 * extract-ip — helper compartido entre `RateLimitGuard` y `AuthController`
 * para obtener la IP del request de forma consistente y segura.
 *
 * Regla dura: **por default NO confiamos en `X-Forwarded-For`**. Sólo lo usamos
 * cuando `trustProxy` es `true` (i.e. estamos detrás de un proxy confiable
 * como Cloudflare / nginx / ALB que setea el header con la IP real).
 *
 * - Sin proxy confiable → devolvemos `req.ip` (lo que ve Express) o `'unknown'`.
 * - Con proxy confiable → tomamos SÓLO la primera IP del XFF, la validamos
 *   contra {@link IP_ALLOWED} y devolvemos `'invalid'` si no matchea.
 *
 * Antes vivía en `rate-limit.guard.ts`; se movió acá para poder reusarlo
 * desde el logging de login fallido sin importar el guard (evita ciclos).
 */
export interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  params?: Record<string, string | undefined>;
}

/**
 * Regex permisiva para IP (v4 o v6). Solo hex, dígitos, `:` y `.`, hasta 45
 * caracteres (largo máximo de un IPv6 con IPv4 embebido). No pretende ser una
 * validación estricta de IP: sólo un sanity check para descartar basura
 * obvia que podría venir en `X-Forwarded-For` cuando el atacante controla
 * el header.
 */
export const IP_ALLOWED = /^[0-9a-f:.]{1,45}$/i;

export function extractIp(req: MinimalRequest, trustProxy: boolean): string {
  if (!trustProxy) {
    return req.ip ?? 'unknown';
  }

  const xff = req.headers['x-forwarded-for'];
  const rawFirst =
    typeof xff === 'string'
      ? xff.split(',')[0]
      : Array.isArray(xff)
        ? xff[0]
        : undefined;

  if (typeof rawFirst !== 'string') {
    return req.ip ?? 'unknown';
  }

  const candidate = rawFirst.trim().slice(0, 45);
  if (candidate.length === 0) {
    return req.ip ?? 'unknown';
  }
  if (!IP_ALLOWED.test(candidate)) {
    return 'invalid';
  }
  return candidate;
}
