import { Injectable, Logger } from '@nestjs/common';
import { stripControlChars } from '../common/sanitize-text';

/** El proveedor no está configurado o no responde. El caller decide el fallback. */
export class SttUnavailableError extends Error {
  constructor(message = 'stt provider not configured') {
    super(message);
    this.name = 'SttUnavailableError';
  }
}

/**
 * El audio ya no está en WAHA. **Es definitivo: no se reintenta.**
 *
 * WAHA borra los ficheros a los 900 s (`WHATSAPP_FILES_LIFETIME`), así que un
 * 404 o un 410 no son un fallo transitorio — reintentar sólo gasta intentos y
 * retrasa el fallback a una persona.
 */
export class MediaExpiredError extends Error {
  constructor(message = 'el audio ya no está disponible en WAHA') {
    super(message);
    this.name = 'MediaExpiredError';
  }
}

/**
 * El audio pasa del tope. **No se reintenta**: no es un fallo, es una respuesta
 * al paciente ("¿me lo resumes?").
 */
export class AudioTooLongError extends Error {
  constructor(message = 'audio demasiado largo') {
    super(message);
    this.name = 'AudioTooLongError';
  }
}

/** Lo que devuelve una transcripción, con su procedencia. */
export interface Transcription {
  text: string;
  /** Modelo que la produjo. El caller lo necesita para marcar el origen. */
  model: string;
}

/**
 * Transcripción de notas de voz (M10).
 *
 * Proveedor: OpenAI `gpt-4o-mini-transcribe`, con `fetch` nativo y sin SDK. La
 * elección **no es por precio** —a nuestro volumen las tres opciones cuestan
 * céntimos— sino porque OpenAI es el único que ya está nombrado en el texto del
 * consent del ADR 0004 §7. Ver [[notas/2026-09-11-exploracion-stt-notas-de-voz]].
 *
 * **El audio no se guarda en ningún momento.** Se descarga a memoria acotada,
 * se transcribe y se descarta; sólo se persiste el texto.
 *
 * **Hay prisa**: WAHA borra el fichero a los 900 s, así que quien encole esto
 * debe usar prioridad alta y backoff corto, y tratar `MediaExpiredError` y
 * `AudioTooLongError` como definitivos.
 *
 * ---
 * **Antes de cablearlo hay que resolver dos cosas que no son de este servicio:**
 *
 * 1. **Consent.** El texto vigente dice que "tus mensajes" se procesan con IA;
 *    mandar *grabaciones* es un salto que ese texto no explica, y el ADR 0004
 *    §7 exige consent explícito o handoff. O entra antes el PR 3 (texto nuevo,
 *    versionado), o esto se cablea detrás de un flag por clínica apagado por
 *    defecto. Encenderlo antes tira por tierra el motivo por el que se eligió
 *    OpenAI en vez de Deepgram.
 * 2. **Las URLs de WAHA no están acotadas por sesión** (`/api/files/<id>`, sin
 *    la clínica). Este servicio comprueba que la URL sea de WAHA y de la ruta
 *    de ficheros, pero no puede comprobar que el fichero sea de *esta* clínica:
 *    esa garantía tiene que venir de que el `media.url` se tome del mismo
 *    payload que ya resolvió el tenant, nunca de una fuente distinta.
 */
@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);

  private static readonly MODEL = 'gpt-4o-mini-transcribe';

  /** Ruta bajo la que WAHA sirve los adjuntos. Todo lo demás se rechaza. */
  private static readonly MEDIA_PATH_PREFIX = '/api/files/';

  /**
   * Tope de duración. Por encima, el paciente recibe una respuesta amable: los
   * audios largos son monólogos, no consultas.
   */
  static readonly MAX_DURATION_SEC = 120;

  /**
   * Tope de descarga, **derivado del de duración**, no elegido aparte.
   *
   * `durationSec` lo declara el mismo payload que manda la URL, así que no es
   * de fiar y puede faltar: el tope que de verdad manda es éste. 120 s de opus
   * de WhatsApp (~16 kbps) son ~250 KB; 1 MB deja margen para otros códecs sin
   * convertir el límite de producto en papel mojado. Con los 5 MB de la primera
   * versión cabían ~40 minutos de audio.
   */
  static readonly MAX_BYTES = 1024 * 1024;

  /** Tipos que aceptamos. Lo que no sea audio no se manda a transcribir. */
  private static readonly ALLOWED_TYPE = /^audio\//i;

  /** Tope del texto devuelto, igual que el del texto entrante del webhook. */
  static readonly MAX_TEXT_CHARS = 4000;

  private static readonly DOWNLOAD_TIMEOUT_MS = 10_000;
  private static readonly TRANSCRIBE_TIMEOUT_MS = 30_000;

  /**
   * Descarga el audio y devuelve su transcripción.
   *
   * @param mediaUrl URL del adjunto, tal como la manda WAHA en el payload.
   * @param opts.clinicId Para los logs. Obligatorio: un log de este servicio
   *   sin tenant no sirve para nada cuando hay que investigar un incidente.
   */
  async transcribe(
    mediaUrl: string,
    opts: { clinicId: string; durationSec?: number; locale?: string },
  ): Promise<Transcription> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new SttUnavailableError();

    if (
      opts.durationSec !== undefined &&
      opts.durationSec > SttService.MAX_DURATION_SEC
    ) {
      throw new AudioTooLongError();
    }

    const audio = await this.download(mediaUrl, opts.clinicId);
    const text = await this.callProvider(audio, key, opts.locale);
    return { text, model: SttService.MODEL };
  }

  /** Descarga acotada del media, con el cuerpo cortado mientras llega. */
  private async download(mediaUrl: string, clinicId: string): Promise<Blob> {
    this.assertIsWahaMediaUrl(mediaUrl, clinicId);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SttService.DOWNLOAD_TIMEOUT_MS,
    );
    try {
      const res = await fetch(mediaUrl, {
        signal: controller.signal,
        headers: this.wahaHeaders(),
        // **Sin seguir redirecciones.** `fetch` las sigue por defecto y el
        // allowlist sólo se aplica a la primera URL: un 30x devolvería el SSRF
        // entero y, peor, undici conserva las cabeceras propias entre saltos,
        // así que la `WAHA_API_KEY` —que abre las sesiones de WhatsApp de
        // TODAS las clínicas— acabaría en el servidor de destino.
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        this.logger.error(
          `media respondió ${res.status} clinic=${clinicId} — redirección rechazada`,
        );
        throw new SttUnavailableError('media redirige fuera de WAHA');
      }
      if (res.status === 404 || res.status === 410) {
        throw new MediaExpiredError(`waha media ${res.status}`);
      }
      if (!res.ok) {
        throw new SttUnavailableError(`waha media ${res.status}`);
      }

      const type = res.headers.get('content-type') ?? '';
      if (!SttService.ALLOWED_TYPE.test(type)) {
        throw new SttUnavailableError(`media no es audio (${type || 'sin tipo'})`);
      }

      const bytes = await this.readCapped(res);
      return new Blob([bytes], { type });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lee el cuerpo cortando en cuanto se pasa del tope.
   *
   * Comprobar `content-length` y después `arrayBuffer()` no protege nada: si la
   * respuesta va en chunked no hay cabecera, y para cuando se mide el tamaño el
   * cuerpo entero ya está en memoria. El segundo check detectaba, no defendía.
   */
  private async readCapped(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > SttService.MAX_BYTES) {
      throw new AudioTooLongError(`media declara ${declared} bytes`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      // Sin stream (mocks, respuestas raras): el buffer completo, pero
      // comprobado. Es el único camino en el que el tope no puede anticiparse.
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > SttService.MAX_BYTES) {
        throw new AudioTooLongError(`media pesa ${buf.byteLength} bytes`);
      }
      return buf;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > SttService.MAX_BYTES) {
          throw new AudioTooLongError(`media pasa de ${SttService.MAX_BYTES} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  /**
   * Sólo se descarga del propio WAHA y sólo de su ruta de ficheros.
   *
   * El host se compara entero, no por prefijo: `startsWith(baseUrl)` deja pasar
   * `http://waha:3000.atacante.com`. Y el **path importa tanto como el host**:
   * la petición lleva la `WAHA_API_KEY`, así que sin acotar la ruta cualquier
   * URL del payload convertía este servicio en un cliente autenticado contra la
   * API de administración de WAHA, con la respuesta enviada a OpenAI.
   */
  private assertIsWahaMediaUrl(mediaUrl: string, clinicId: string): void {
    const base = process.env.WAHA_BASE_URL;
    if (!base) {
      // Sin default: un `?? 'http://localhost:3000'` degrada el allowlist al
      // propio host, que es el peor destino posible para un SSRF.
      throw new SttUnavailableError('WAHA_BASE_URL no configurada');
    }

    let target: URL;
    let expected: URL;
    try {
      target = new URL(mediaUrl);
      expected = new URL(base);
    } catch {
      throw new SttUnavailableError('media url inválida');
    }

    const reason =
      target.username || target.password
        ? 'lleva credenciales'
        : target.protocol !== expected.protocol
          ? 'otro protocolo'
          : target.host !== expected.host
            ? 'otro host'
            : !target.pathname.startsWith(SttService.MEDIA_PATH_PREFIX)
              ? 'fuera de la ruta de ficheros'
              : null;

    if (reason) {
      // Sin la URL ni el path: llevan un identificador del chat.
      this.logger.error(
        `media url rechazada (${reason}) clinic=${clinicId} host=${target.host}`,
      );
      throw new SttUnavailableError(`media url rechazada: ${reason}`);
    }
  }

  private wahaHeaders(): Record<string, string> {
    const apiKey = process.env.WAHA_API_KEY;
    return apiKey ? { 'X-Api-Key': apiKey } : {};
  }

  /** Multipart a OpenAI. Devuelve el texto saneado y acotado. */
  private async callProvider(
    audio: Blob,
    key: string,
    locale?: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('file', audio, 'nota-de-voz.ogg');
    form.append('model', SttService.MODEL);
    if (locale) form.append('language', locale);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SttService.TRANSCRIBE_TIMEOUT_MS,
    );
    try {
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        // Sólo el status: el cuerpo del error de OpenAI a veces repite parte
        // del request.
        throw new SttUnavailableError(`openai transcriptions ${res.status}`);
      }
      const data = (await res.json()) as { text?: unknown };
      const raw = typeof data.text === 'string' ? data.text : '';
      // Mismo trato que el texto que entra por el webhook: sin caracteres de
      // control y con el mismo tope, porque va al mismo sitio (Message.body,
      // el prompt del LLM y la bandeja del panel).
      const text = stripControlChars(raw).trim().slice(0, SttService.MAX_TEXT_CHARS);
      if (!text) {
        throw new SttUnavailableError('transcripción vacía');
      }
      return text;
    } catch (e) {
      // Un abort sale como `DOMException`, que el caller no sabría clasificar:
      // envuelto, queda claro que es infraestructura y se puede reintentar.
      if (e instanceof SttUnavailableError) throw e;
      if ((e as Error)?.name === 'AbortError') {
        throw new SttUnavailableError('openai transcriptions timeout');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
