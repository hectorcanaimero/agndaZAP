import { Injectable, Logger } from '@nestjs/common';

/**
 * Cliente de WAHA (WhatsApp HTTP API, no oficial).
 * Envía mensajes y gestiona la sesión de cada clínica.
 * Docs: https://waha.devlike.pro/
 */
@Injectable()
export class WahaService {
  private readonly logger = new Logger(WahaService.name);
  private readonly baseUrl = process.env.WAHA_BASE_URL ?? 'http://localhost:3000';
  private readonly apiKey = process.env.WAHA_API_KEY ?? 'dev-waha-key';

  private headers() {
    return {
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
    };
  }

  /** Normaliza un teléfono E.164 a chatId de WhatsApp (ej. 584141234567@c.us). */
  private toChatId(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return `${digits}@c.us`;
  }

  async sendText(session: string, phoneOrChatId: string, text: string): Promise<void> {
    const chatId = phoneOrChatId.includes('@')
      ? phoneOrChatId
      : this.toChatId(phoneOrChatId);

    const res = await fetch(`${this.baseUrl}/api/sendText`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ session, chatId, text }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`WAHA sendText falló (${res.status}): ${body}`);
      throw new Error(`WAHA sendText ${res.status}`);
    }
  }

  /**
   * Crea/inicia una sesion para una clinica.
   *
   * Estrategia (WAHA API):
   *   1) POST /api/sessions con `config.noweb.store.{enabled,fullSync}=true`.
   *      El store persiste chats/contactos en SQLite (`.sessions/noweb/{s}/store.sqlite3`)
   *      y habilita `/api/contacts` y `/api/{s}/chats/{id}/messages` (necesario para
   *      poder resolver metadata del contacto cuando llega un mensaje).
   *   2) POST /api/sessions/{name}/start para arrancarla.
   *
   * Si la sesion ya existe (POST /api/sessions retorna 409/422), caemos al
   * endpoint legacy `POST /api/sessions/start` que solo reinicia. IMPORTANTE:
   * sesiones creadas antes de este cambio NO tienen store habilitado — hay que
   * eliminarlas y re-escanear QR para activarlo (ver ADR-XXXX).
   *
   * `fullSync: false` sincroniza ~3 meses de historial (default). `true` iria a
   * ~1 año pero puede llevar minutos y romper el UX del onboarding. Nos sobra
   * con 3 meses para resolver contactos que ya escribieron a la clinica.
   *
   * Consistency fix (T3): mirroring del patron de `sendText` y `logoutSession`,
   * tira `Error` en `!res.ok` para que el controller pueda envolverlo como
   * `BadGatewayException`. Antes fallaba en silencio.
   */
  async startSession(session: string): Promise<void> {
    // 1) Intentar crear con config del store.
    const createRes = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        name: session,
        start: true,
        config: {
          noweb: {
            store: {
              enabled: true,
              fullSync: false,
            },
          },
        },
      }),
    });

    if (createRes.ok) return;

    // Sesion ya existe → caer al start legacy (no reconfigura el store).
    if (createRes.status === 409 || createRes.status === 422) {
      const startRes = await fetch(`${this.baseUrl}/api/sessions/start`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: session }),
      });
      if (!startRes.ok) {
        const body = await startRes.text();
        this.logger.error(`WAHA startSession failed (${startRes.status}): ${body}`);
        throw new Error(`WAHA startSession ${startRes.status}`);
      }
      return;
    }

    const body = await createRes.text();
    this.logger.error(`WAHA createSession failed (${createRes.status}): ${body}`);
    throw new Error(`WAHA createSession ${createRes.status}`);
  }

  async getSessionStatus(session: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${session}`, {
      headers: this.headers(),
    });
    if (!res.ok) return 'UNKNOWN';
    const data = (await res.json()) as { status?: string };
    return data.status ?? 'UNKNOWN';
  }

  /**
   * Termina la sesion y borra credenciales en WAHA.
   * El proximo `startSession` volvera a exigir escaneo de QR.
   * Endpoint: `POST /api/sessions/{session}/logout`.
   */
  async logoutSession(session: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${session}/logout`,
      {
        method: 'POST',
        headers: this.headers(),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`WAHA logout failed (${res.status}): ${body}`);
      throw new Error(`WAHA logout ${res.status}`);
    }
  }

  /**
   * Consulta el QR de emparejamiento cuando la sesion esta en `SCAN_QR_CODE`.
   * Endpoint legacy verificado en `devlikeapro/waha:latest`:
   *   `GET /api/{session}/auth/qr` con `Accept: application/json`.
   *
   * Respuesta esperada: `{ mimetype: 'image/png', data: '<base64>' }`.
   * Devuelve un data URL listo para `<img src>` o `null` si:
   *   - WAHA responde 404 (sesion no en estado de QR).
   *   - WAHA responde 5xx u otro no-2xx (fallo defensivo, no cachear).
   *   - El campo `data` viene vacio o ausente.
   *
   * IMPORTANTE: nunca loguear `data` (es material sensible que permite
   * secuestrar la sesion de WhatsApp de la clinica).
   */
  async getQrCode(session: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/${session}/auth/qr`, {
      method: 'GET',
      headers: {
        'X-Api-Key': this.apiKey,
        Accept: 'application/json',
      },
    });

    if (res.status === 404 || !res.ok) {
      return null;
    }

    const data = (await res.json()) as { mimetype?: string; data?: string };
    if (!data.data) {
      return null;
    }

    return `data:${data.mimetype ?? 'image/png'};base64,${data.data}`;
  }

  /**
   * Resuelve la foto de perfil de un contacto (funciona con `@c.us` y `@lid`).
   * Devuelve `null` cuando el contacto no tiene foto o WAHA no responde OK.
   *
   * Endpoint: `GET /api/contacts/profile-picture?session={s}&contactId={id}`.
   * La URL devuelta es de `pps.whatsapp.net` y expira cada ~48h — el caller
   * debe cachearla con TTL y refrescarla cuando corresponda.
   */
  async getContactAvatar(session: string, contactId: string): Promise<string | null> {
    const url = new URL(`${this.baseUrl}/api/contacts/profile-picture`);
    url.searchParams.set('session', session);
    url.searchParams.set('contactId', contactId);

    try {
      const res = await fetch(url.toString(), { headers: this.headers() });
      if (!res.ok) return null;
      const data = (await res.json()) as { profilePictureURL?: string };
      return data.profilePictureURL ?? null;
    } catch (e) {
      // WAHA caido / red rota — degradamos silenciosamente para no romper el
      // ingest de mensajes por un avatar.
      this.logger.warn(`getContactAvatar falló: ${(e as Error).message}`);
      return null;
    }
  }
}
