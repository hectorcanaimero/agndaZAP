import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../public/rate-limit.guard';

/**
 * Datos que viven detrás de un token de agendamiento por link WA.
 *
 * `clinicSlug` va guardado (no sólo `clinicId`) para que la validación en el
 * endpoint `POST /public/:slug/appointments` sea trivial: el token debe
 * matchear el slug de la URL. Cualquier otro slug → 400, cero fuga entre
 * tenants aunque el token se filtre.
 *
 * `phone` puede ser `null` cuando la Conversation llegó como `@lid` (ver
 * ADR 0010). En ese caso el form pide el teléfono como required editable;
 * cuando el phone está presente, el form lo muestra readonly para no romper
 * el linkeo WA↔cita.
 */
export interface SchedulingSessionData {
  conversationId: string;
  clinicId: string;
  clinicSlug: string;
  phone: string | null;
  lid: string | null;
  name: string | null;
  createdAtISO: string;
}

const SESSION_KEY_PREFIX = 'sched:sess:';
const DEFAULT_TTL_SECONDS = 30 * 60; // 30 min — suficiente para completar el flujo.
const TOKEN_BYTES = 24; // 24 bytes → 32 chars base64url. ~192 bits de entropía.

/**
 * SchedulingSessionService — tokens efímeros que ligan una conversación de
 * WhatsApp con una sesión de agendamiento web.
 *
 * Storage: Redis (mismo singleton global que rate-limit). Efímero por diseño
 * — no queremos historial ni queries; una tabla Postgres sería sobre-ingeniería.
 *
 * Ciclo de vida:
 *   1. `create({ ... })` → devuelve token + URL.
 *   2. Front hace `GET /public/scheduling/session/:token` → `resolve()`.
 *      Este NO consume — el usuario puede recargar el form varias veces.
 *   3. Al crear la cita, `POST /public/:slug/appointments` → `consume()`.
 *      Este SÍ borra el token: un token, una cita.
 *
 * Seguridad:
 * - Token URL-safe (base64url), ~192 bits de entropía → no adivinable.
 * - Storage encriptado sólo si Redis está protegido a nivel red; el token en
 *   sí no lleva secretos criptográficos, sólo referencias.
 * - PII en el valor (name/phone) — Redis con AUTH y sin persist a disco es lo
 *   que garantiza no leak. No loggeamos el contenido, sólo el token prefix.
 */
@Injectable()
export class SchedulingSessionService {
  private readonly logger = new Logger(SchedulingSessionService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async create(
    input: Omit<SchedulingSessionData, 'createdAtISO'>,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const data: SchedulingSessionData = {
      ...input,
      createdAtISO: new Date().toISOString(),
    };
    const key = SESSION_KEY_PREFIX + token;
    await this.redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    // Log sin PII: sólo token prefix + clinic slug para trazabilidad.
    this.logger.log(
      `session created slug=${input.clinicSlug} token=${token.slice(0, 6)}… ttl=${ttlSeconds}`,
    );
    return { token, expiresInSeconds: ttlSeconds };
  }

  /**
   * Lookup no destructivo. El caller decide qué hacer si es null (típicamente
   * responder 404 al front con un mensaje "tu link expiró, pedí uno nuevo").
   */
  async resolve(token: string): Promise<SchedulingSessionData | null> {
    if (!isPlausibleToken(token)) return null;
    const raw = await this.redis.get(SESSION_KEY_PREFIX + token);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SchedulingSessionData;
    } catch (e) {
      // Un valor corrupto en Redis es un bug — logueamos y devolvemos null.
      // NO tiramos: preferimos degradar a "token inválido" que 500.
      this.logger.error(
        `session JSON parse failed token=${token.slice(0, 6)}… err=${String(e)}`,
      );
      return null;
    }
  }

  /**
   * Lookup + delete atómico. Usamos pipeline (GET + DEL) en vez de LUA porque
   * ioredis atomiza el pipeline en un solo RTT — dos requests concurrentes
   * verán uno el valor y otro null. Suficiente garantía para "un token, una
   * cita".
   */
  async consume(token: string): Promise<SchedulingSessionData | null> {
    if (!isPlausibleToken(token)) return null;
    const key = SESSION_KEY_PREFIX + token;
    const pipeline = this.redis.pipeline();
    pipeline.get(key);
    pipeline.del(key);
    const results = await pipeline.exec();
    if (!results) return null;
    const [getErr, raw] = results[0] ?? [null, null];
    if (getErr || typeof raw !== 'string') return null;
    try {
      const data = JSON.parse(raw) as SchedulingSessionData;
      this.logger.log(
        `session consumed slug=${data.clinicSlug} token=${token.slice(0, 6)}…`,
      );
      return data;
    } catch {
      return null;
    }
  }
}

/**
 * Validación barata anti-basura: descarta tokens que ni siquiera podrían haber
 * salido de `randomBytes(24).toString('base64url')`. Evita hits a Redis por
 * strings arbitrarios (ej. `undefined`, SQLi, XSS).
 */
function isPlausibleToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length >= 20 &&
    token.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}
