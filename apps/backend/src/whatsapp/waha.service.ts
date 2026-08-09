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
   * Consistency fix (T3): mirroring del patron de `sendText` y `logoutSession`,
   * tira `Error` en `!res.ok` para que el controller pueda envolverlo como
   * `BadGatewayException`. Antes fallaba en silencio.
   */
  async startSession(session: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name: session }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`WAHA startSession failed (${res.status}): ${body}`);
      throw new Error(`WAHA startSession ${res.status}`);
    }
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
}
