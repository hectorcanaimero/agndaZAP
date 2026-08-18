import { createHmac, timingSafeEqual } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';

// Resultado explícito para poder loguear el mecanismo usado en el controller
// (útil para debugging + auditar qué método autenticó el request).
export type WebhookAuthResult = 'hmac' | 'token' | 'skip-explicit';

export interface WebhookAuthInput {
  rawBody: Buffer | undefined;
  token: string | undefined;
  hmacHeader: string | undefined;
  // Inyectables via env — pasamos como argumento para hacer la función pura
  // (testable sin cambiar process.env).
  hmacSecret: string | undefined;
  requiredToken: string | undefined;
  allowNoAuth: boolean;
  isProd: boolean;
}

/**
 * Verifica la autenticidad del webhook WAHA. Función pura para test.
 *
 * Preferencia (más fuerte primero):
 *  1. HMAC del body raw con WEBHOOK_HMAC_SECRET (WAHA Plus / self-hosted con secret)
 *  2. Shared token via header x-webhook-token con WEBHOOK_TOKEN (WAHA community)
 *  3. Skip con ALLOW_WEBHOOK_WITHOUT_TOKEN=true (solo dev, opt-in explícito)
 *
 * Cualquier otro caso → ForbiddenException.
 *
 * Notas:
 * - Si `hmacSecret` está seteado, se EXIGE HMAC — no hay downgrade a token
 *   (evita downgrade attack donde un atacante manda token válido esperando
 *   que el backend acepte cualquier auth disponible).
 * - HMAC firma acepta formato `sha256=<hex>` (GitHub convention) o `<hex>` puro.
 * - Comparación con `crypto.timingSafeEqual` para evitar timing attacks.
 */
export function verifyWebhookAuth(input: WebhookAuthInput): WebhookAuthResult {
  const {
    rawBody,
    token,
    hmacHeader,
    hmacSecret,
    requiredToken,
    allowNoAuth,
    isProd,
  } = input;

  // Mecanismo 1: HMAC.
  if (hmacSecret) {
    if (!hmacHeader) {
      throw new ForbiddenException('firma HMAC ausente');
    }
    if (!rawBody) {
      throw new ForbiddenException('raw body no disponible para HMAC');
    }
    const expected = createHmac('sha256', hmacSecret)
      .update(rawBody)
      .digest('hex');
    const received = hmacHeader.startsWith('sha256=')
      ? hmacHeader.slice(7)
      : hmacHeader;
    const expectedBuf = Buffer.from(expected, 'hex');
    let receivedBuf: Buffer;
    try {
      receivedBuf = Buffer.from(received, 'hex');
    } catch {
      throw new ForbiddenException('firma HMAC malformada');
    }
    if (
      expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      throw new ForbiddenException('firma HMAC inválida');
    }
    return 'hmac';
  }

  // Mecanismo 2: shared token.
  if (requiredToken) {
    if (token !== requiredToken) {
      throw new ForbiddenException('token de webhook inválido');
    }
    return 'token';
  }

  // Mecanismo 3: skip explícito. Nunca en prod.
  if (allowNoAuth && !isProd) {
    return 'skip-explicit';
  }

  // Fail-closed default.
  throw new ForbiddenException(
    isProd
      ? 'WEBHOOK_HMAC_SECRET o WEBHOOK_TOKEN son obligatorios en producción'
      : 'webhook sin auth — setear WEBHOOK_HMAC_SECRET, WEBHOOK_TOKEN o ALLOW_WEBHOOK_WITHOUT_TOKEN=true',
  );
}

/**
 * Adapter que lee las envs y llama a `verifyWebhookAuth`. Uso del controller.
 */
export function verifyWebhookAuthFromEnv(
  rawBody: Buffer | undefined,
  token: string | undefined,
  hmacHeader: string | undefined,
): WebhookAuthResult {
  return verifyWebhookAuth({
    rawBody,
    token,
    hmacHeader,
    hmacSecret: process.env.WEBHOOK_HMAC_SECRET,
    requiredToken: process.env.WEBHOOK_TOKEN,
    allowNoAuth: process.env.ALLOW_WEBHOOK_WITHOUT_TOKEN === 'true',
    isProd: process.env.NODE_ENV === 'production',
  });
}
