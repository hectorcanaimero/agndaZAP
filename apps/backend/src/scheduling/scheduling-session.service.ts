import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../public/rate-limit.guard';
import { manageAppointmentUrl } from '../common/web-url.util';

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

/**
 * Datos detrás de un token de **gestión de cita** (ADR 0020). Distinto del de
 * agendamiento: no crea nada, da acceso a UNA cita ya existente para verla,
 * cancelarla o moverla desde `/agendar/{slug}/cita?t={token}`.
 *
 * `kind` va en el payload además de en el prefijo de la clave: el prefijo ya
 * separa los dos espacios, pero un chequeo explícito hace que un token de
 * agendamiento no pueda colarse por un endpoint de gestión ni al revés aunque
 * alguien cambie los prefijos.
 *
 * `clinicSlug` se guarda por el mismo motivo que en la sesión de agendamiento:
 * el endpoint compara contra el `:slug` de la URL y corta cualquier reuso
 * cruzado entre clínicas.
 *
 * Deliberadamente NO guarda el teléfono del paciente. La sesión de agendamiento
 * sí lo lleva porque lo necesita para pre-rellenar el formulario; acá no lo
 * consume nadie, y sería PII de salud viviendo en Redis hasta 30 días, en una
 * clave por token emitido, sin ningún propósito. Para atar la cita al chat ya
 * está `Appointment.conversationId`.
 */
export interface ManageSessionData {
  kind: 'manage';
  appointmentId: string;
  clinicId: string;
  clinicSlug: string;
  createdAtISO: string;
}

const SESSION_KEY_PREFIX = 'sched:sess:';
const MANAGE_KEY_PREFIX = 'sched:manage:';
/**
 * Índice `appointmentId → tokens vivos`. Sin él solo se puede quemar el token
 * que el paciente acaba de usar, y como se emiten varios por cita (respuesta
 * del POST, recordatorios, mensajes del bot) los demás sobreviven apuntando a
 * una cita que ya no existe como tal.
 */
const MANAGE_INDEX_PREFIX = 'sched:manage:appt:';
const DEFAULT_TTL_SECONDS = 30 * 60; // 30 min — suficiente para completar el flujo.
/**
 * El token de gestión vive hasta el inicio de la cita: después ya no se puede
 * ni cancelar ni mover (`canCancel` exige `startAt > now`), así que mantenerlo
 * vivo solo sería superficie de ataque.
 *
 * Suelo de 30 min: una cita creada para dentro de 10 minutos igual necesita un
 * link usable, y un TTL de segundos daría un 404 desconcertante.
 * Techo de 30 días: una cita a 6 meses no debe dejar un token válido medio año
 * en Redis.
 */
const MANAGE_MIN_TTL_SECONDS = 30 * 60;
const MANAGE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
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

  // ───────────────────────── Tokens de gestión (ADR 0020) ─────────────────────

  /**
   * Emite el token de gestión de una cita. El TTL se deriva de `startAt`
   * (acotado entre 30 min y 30 días) para que el link muera con la cita.
   *
   * Se emite en varios sitios (respuesta del POST público, recordatorios,
   * confirmación del bot), así que puede haber varios tokens vivos a la vez
   * para la misma cita. Es intencional: invalidar los anteriores obligaría a
   * mantener un índice `appointmentId → tokens` y el beneficio es nulo — todos
   * apuntan a la misma cita y caducan solos.
   */
  async createManage(
    input: Omit<ManageSessionData, 'kind' | 'createdAtISO'>,
    startAt: Date,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const secondsToStart = Math.floor((startAt.getTime() - Date.now()) / 1000);
    const ttlSeconds = Math.min(
      MANAGE_MAX_TTL_SECONDS,
      Math.max(MANAGE_MIN_TTL_SECONDS, secondsToStart),
    );

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const data: ManageSessionData = {
      kind: 'manage',
      ...input,
      createdAtISO: new Date().toISOString(),
    };
    await this.redis.set(
      MANAGE_KEY_PREFIX + token,
      JSON.stringify(data),
      'EX',
      ttlSeconds,
    );

    // Índice para poder quemarlos TODOS cuando la cita deja de ser gestionable.
    // Best-effort: si esto falla, el token sigue siendo válido y funcional —
    // solo perdemos la capacidad de revocarlo antes de su TTL, que es peor que
    // nada pero mucho mejor que no emitir el link.
    //
    // El TTL del índice es el techo (30 días) y no el del token: si un token
    // posterior tuviera un TTL más corto y el índice heredara ese, el índice
    // moriría antes que un token más antiguo y lo dejaría huérfano justo en el
    // caso que esto viene a evitar.
    try {
      const indexKey = MANAGE_INDEX_PREFIX + input.appointmentId;
      await this.redis.sadd(indexKey, token);
      await this.redis.expire(indexKey, MANAGE_MAX_TTL_SECONDS);
    } catch (e) {
      this.logger.warn(
        `no se pudo indexar el manage token slug=${input.clinicSlug}: ${(e as Error).message}`,
      );
    }
    // Sin PII y sin appointmentId crudo: slug + prefijo del token bastan para
    // seguir el rastro en logs.
    this.logger.log(
      `manage token created slug=${input.clinicSlug} token=${token.slice(0, 6)}… ttl=${ttlSeconds}`,
    );
    return { token, expiresInSeconds: ttlSeconds };
  }

  /**
   * Lookup no destructivo: el paciente puede abrir el link, mirar la cita,
   * recargar y volver más tarde. Solo `cancel` y `reschedule` lo invalidan.
   */
  /**
   * Emite un token de gestión y devuelve la URL lista para mandar (ADR 0020).
   *
   * Única fuente del link de gestión: lo usan el endpoint público, el bot y el
   * processor de recordatorios. Si cambia el dominio o la forma de la ruta, se
   * cambia aquí y en `web-url.util.ts`, no en tres sitios (S21).
   */
  async issueManageUrl(
    appt: { id: string; clinicId: string; startAt: Date },
    clinicSlug: string,
    locale: string,
  ): Promise<string> {
    const { token } = await this.createManage(
      { appointmentId: appt.id, clinicId: appt.clinicId, clinicSlug },
      appt.startAt,
    );
    return manageAppointmentUrl(locale, clinicSlug, token);
  }

  async resolveManage(token: string): Promise<ManageSessionData | null> {
    if (!isPlausibleToken(token)) return null;
    const raw = await this.redis.get(MANAGE_KEY_PREFIX + token);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as ManageSessionData;
      // Un payload sin `kind: 'manage'` no salió de `createManage`.
      if (data?.kind !== 'manage') return null;
      return data;
    } catch (e) {
      this.logger.error(
        `manage token JSON parse failed token=${token.slice(0, 6)}… err=${String(e)}`,
      );
      return null;
    }
  }

  /**
   * Quema el token. Se llama tras cancelar (la cita ya no es gestionable) y
   * tras reagendar (se emite uno nuevo con el TTL del horario nuevo).
   *
   * Best-effort: si Redis falla no abortamos la operación — la cita ya cambió
   * y el token caduca solo. El peor caso es un link que muestra un estado que
   * ya no permite acciones, y los endpoints revalidan el estado igualmente.
   */
  async invalidateManage(token: string): Promise<void> {
    if (!isPlausibleToken(token)) return;
    try {
      await this.redis.del(MANAGE_KEY_PREFIX + token);
    } catch (e) {
      this.logger.warn(
        `no se pudo invalidar el manage token=${token.slice(0, 6)}…: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Quema TODOS los tokens vivos de una cita.
   *
   * Se llama cuando la cita deja de ser gestionable —la cancela la clínica
   * desde el panel, o pasa a un estado terminal— porque a partir de ahí un
   * token solo sirve para leer datos del paciente: nombre, servicio,
   * profesional y horario. No permite mutar nada (`isPatientMutable` corta),
   * pero exponerlos sin motivo durante los hasta 30 días que vive el link es
   * justo lo que este índice viene a cerrar.
   *
   * Best-effort y sin lanzar: la cancelación que lo motivó ya está persistida y
   * no se deshace por no poder limpiar Redis. Los tokens caducan solos.
   *
   * @returns cuántos tokens se quemaron (0 si no había índice).
   */
  async invalidateAllForAppointment(appointmentId: string): Promise<number> {
    const indexKey = MANAGE_INDEX_PREFIX + appointmentId;
    try {
      const tokens = await this.redis.smembers(indexKey);
      if (tokens.length === 0) {
        await this.redis.del(indexKey);
        return 0;
      }
      await this.redis.del(
        ...tokens.map((t) => MANAGE_KEY_PREFIX + t),
        indexKey,
      );
      this.logger.log(
        `manage tokens invalidados apptId=${appointmentId} n=${tokens.length}`,
      );
      return tokens.length;
    } catch (e) {
      this.logger.warn(
        `no se pudieron invalidar los manage tokens apptId=${appointmentId}: ${(e as Error).message}`,
      );
      return 0;
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
