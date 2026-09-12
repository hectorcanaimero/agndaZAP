import { Logger } from '@nestjs/common';
import {
  AudioTooLongError,
  MediaExpiredError,
  SttService,
  SttUnavailableError,
} from './stt.service';

/**
 * Tests del transcriptor de notas de voz (M10). El proveedor y WAHA van
 * mockeados por `global.fetch`: el objetivo no es probar que OpenAI transcribe
 * —eso es suyo— sino las cotas y los rechazos, que es donde este servicio puede
 * hacer daño.
 */
describe('SttService', () => {
  const WAHA = 'http://waha:3000';
  const MEDIA = `${WAHA}/api/files/false_5804_audio.oga`;
  const CLINIC = { clinicId: 'clinic-A' };
  const originalEnv = { ...process.env };
  let service: SttService;
  let calls: string[];

  /** Respuesta de WAHA con un cuerpo de audio de mentira. */
  /** Cuerpo como stream, que es como llega de verdad. */
  function bodyOf(bytes: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const size = Math.min(64 * 1024, bytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    });
  }

  function mediaResponse(
    bytes: number,
    opts: {
      declared?: number | null;
      ok?: boolean;
      status?: number;
      type?: string;
      stream?: boolean;
    } = {},
  ): Response {
    const { ok = true, type = 'audio/ogg', stream = false } = opts;
    const status = opts.status ?? (ok ? 200 : 500);
    const declared = opts.declared === undefined ? bytes : opts.declared;
    const headers = new Headers({ 'content-type': type });
    if (declared !== null) headers.set('content-length', String(declared));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      body: stream ? bodyOf(bytes) : null,
      arrayBuffer: jest.fn(async () => new ArrayBuffer(bytes)),
    } as unknown as Response;
  }

  function openaiResponse(body: unknown, ok = true): Response {
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as unknown as Response;
  }

  /** Encadena: primera llamada = WAHA, segunda = OpenAI. */
  function mockFetch(media: Response, provider?: Response) {
    global.fetch = jest.fn().mockImplementation(async (url: string | URL) => {
      calls.push(String(url));
      return calls.length === 1 ? media : (provider ?? openaiResponse({ text: 'hola' }));
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.WAHA_BASE_URL = WAHA;
    process.env.WAHA_API_KEY = 'waha-key';
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new SttService();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('transcribe y devuelve el texto con su procedencia', async () => {
    mockFetch(mediaResponse(1000), openaiResponse({ text: '  quiero una cita  ' }));

    // Con el modelo, para que el caller pueda marcar en la bandeja que es una
    // transcripción automática y no lo que el paciente escribió. Una
    // transcripción errónea de un síntoma leída como palabra del paciente es
    // un problema clínico, no sólo de producto.
    await expect(service.transcribe(MEDIA, CLINIC)).resolves.toEqual({
      text: 'quiero una cita',
      model: 'gpt-4o-mini-transcribe',
    });
  });

  it('manda el modelo de la nota de exploración y el idioma de la clínica', async () => {
    let form: FormData | undefined;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (calls.length === 1) return mediaResponse(1000);
      form = init?.body as FormData;
      return openaiResponse({ text: 'hola' });
    }) as unknown as typeof fetch;

    await service.transcribe(MEDIA, { ...CLINIC, locale: 'es' });

    expect(form?.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form?.get('language')).toBe('es');
  });

  it('sin OPENAI_API_KEY no descarga nada', async () => {
    delete process.env.OPENAI_API_KEY;
    mockFetch(mediaResponse(1000));

    await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
      SttUnavailableError,
    );
    expect(calls).toHaveLength(0);
  });

  /**
   * La URL del media sale del payload del webhook, o sea de fuera. Sin este
   * corte, el backend es un cliente HTTP que un tercero dirige a donde quiera:
   * su red interna, o el endpoint de metadatos del proveedor de nube.
   */
  describe('sólo descarga del propio WAHA (SSRF)', () => {
    it.each([
      ['otro host', 'http://atacante.com/audio.oga'],
      ['metadatos de nube', 'http://169.254.169.254/latest/meta-data/'],
      ['el propio backend', 'http://localhost:4000/api/admin/clinics'],
      // `startsWith(baseUrl)` habría dejado pasar ésta.
      ['host que empieza igual', 'http://waha:3000.atacante.com/audio.oga'],
      ['mismo host, otro protocolo', 'https://waha:3000/audio.oga'],
      ['no es una URL', 'no-una-url'],
    ])('rechaza %s sin llamar a nadie', async (_caso, url) => {
      mockFetch(mediaResponse(1000));

      await expect(service.transcribe(url, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(calls).toHaveLength(0);
    });

    it('el log del rechazo no lleva la URL, que identifica el chat', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      mockFetch(mediaResponse(1000));

      await expect(
        service.transcribe('http://atacante.com/api/files/false_584141234567_x.oga', CLINIC),
      ).rejects.toThrow();

      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).not.toContain('584141234567');
      }
    });
  });

  describe('cotas', () => {
    it('una duración declarada por encima del tope se rechaza antes de descargar', async () => {
      mockFetch(mediaResponse(1000));

      await expect(
        service.transcribe(MEDIA, { ...CLINIC, durationSec: 121 }),
      ).rejects.toBeInstanceOf(AudioTooLongError);
      expect(calls).toHaveLength(0);
    });

    it('justo en el tope sí se transcribe', async () => {
      mockFetch(mediaResponse(1000));
      await expect(
        service.transcribe(MEDIA, { ...CLINIC, durationSec: 120 }),
      ).resolves.toMatchObject({ text: 'hola' });
    });

    it('sin duración declarada se transcribe igual: el tope real es el de bytes', async () => {
      // `durationSec` lo declara el mismo payload que manda la URL, así que
      // omitirlo desactivaría el tope si fuera el único.
      mockFetch(mediaResponse(1000));
      await expect(service.transcribe(MEDIA, CLINIC)).resolves.toMatchObject({
        text: 'hola',
      });
    });

    it('el tope de bytes se corresponde con la duración de producto', () => {
      // 120 s de opus de WhatsApp son ~250 KB. Con 5 MB cabían ~40 minutos y
      // el límite de producto era papel mojado.
      expect(SttService.MAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
    });

    it('un content-length por encima del tope corta antes de bajar el cuerpo', async () => {
      const res = mediaResponse(10, { declared: 99_000_000 });
      const arrayBuffer = jest.fn();
      mockFetch({ ...res, arrayBuffer } as unknown as Response);

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        AudioTooLongError,
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('un content-length que miente tampoco pasa: se comprueban los bytes reales', async () => {
      mockFetch(mediaResponse(6 * 1024 * 1024, { declared: 10 }));

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        AudioTooLongError,
      );
    });
  });

  describe('fallos del proveedor', () => {
    it('WAHA responde no-2xx', async () => {
      mockFetch(mediaResponse(0, { ok: false, status: 502 }));
      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
    });

    /**
     * WAHA borra los ficheros a los 900 s. Un 404 no es "vuelve a intentarlo":
     * el audio no existe y no va a volver. Distinguirlo importa porque el
     * caller reintenta los `SttUnavailableError` y eso sólo retrasaría el
     * fallback a una persona.
     */
    it.each([404, 410])('%s de WAHA es definitivo, no transitorio', async (status) => {
      mockFetch(mediaResponse(0, { ok: false, status }));

      const err = await service.transcribe(MEDIA, CLINIC).catch((e) => e);
      expect(err).toBeInstanceOf(MediaExpiredError);
      expect(err).not.toBeInstanceOf(SttUnavailableError);
    });

    it('no llama al proveedor si el audio caducó: no se paga por nada', async () => {
      mockFetch(mediaResponse(0, { ok: false, status: 404 }));
      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toThrow();
      expect(calls).toHaveLength(1);
    });

    it('OpenAI responde no-2xx', async () => {
      mockFetch(mediaResponse(1000), openaiResponse({}, false));
      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
    });

    it('una transcripción vacía es un fallo, no un mensaje vacío', async () => {
      // Si devolviéramos '', el bot trataría el audio como un mensaje sin
      // texto y el paciente recibiría un fallback sin sentido.
      mockFetch(mediaResponse(1000), openaiResponse({ text: '   ' }));
      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
    });

    it('una respuesta con forma inesperada tampoco se cuela', async () => {
      mockFetch(mediaResponse(1000), openaiResponse({ text: { raro: true } }));
      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
    });
  });

  it('se autentica contra WAHA', async () => {
    let headers: Record<string, string> | undefined;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (calls.length === 1) {
        headers = init?.headers as Record<string, string>;
        return mediaResponse(1000);
      }
      return openaiResponse({ text: 'hola' });
    }) as unknown as typeof fetch;

    await service.transcribe(MEDIA, CLINIC);

    expect(headers?.['X-Api-Key']).toBe('waha-key');
  });

  describe('bypasses que el allowlist de sólo-host dejaba pasar', () => {
    it.each([
      ['la API de WAHA', 'http://waha:3000/api/sessions'],
      ['el QR de una sesión', 'http://waha:3000/api/default/auth/qr'],
      ['traversal hacia la API', 'http://waha:3000/api/files/../sessions'],
      ['con credenciales', 'http://user:pass@waha:3000/api/files/a.oga'],
    ])('rechaza %s', async (_caso, url) => {
      // La petición lleva la WAHA_API_KEY, que abre las sesiones de WhatsApp
      // de TODAS las clínicas: sin acotar el path, esto era un cliente
      // autenticado contra la API de administración, con la respuesta enviada
      // a OpenAI.
      mockFetch(mediaResponse(1000));

      await expect(service.transcribe(url, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(calls).toHaveLength(0);
    });

    it('sin WAHA_BASE_URL no descarga: un default degradaría el allowlist a localhost', async () => {
      delete process.env.WAHA_BASE_URL;
      mockFetch(mediaResponse(1000));

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(calls).toHaveLength(0);
    });

    it('pide con redirect manual', async () => {
      let init: RequestInit | undefined;
      global.fetch = jest.fn().mockImplementation(async (url: string, i?: RequestInit) => {
        calls.push(String(url));
        if (calls.length === 1) {
          init = i;
          return mediaResponse(1000);
        }
        return openaiResponse({ text: 'hola' });
      }) as unknown as typeof fetch;

      await service.transcribe(MEDIA, CLINIC);

      // `follow` (el default) devuelve el SSRF entero, y undici conserva las
      // cabeceras propias entre saltos: la clave de WAHA acabaría en el
      // destino de la redirección.
      expect(init?.redirect).toBe('manual');
    });

    it.each([301, 302, 307, 308])('un %s se rechaza en vez de seguirse', async (status) => {
      mockFetch(mediaResponse(0, { status }));

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe('el cuerpo se corta mientras llega', () => {
    it('sin content-length el tope sigue aplicando', async () => {
      // Éste es el caso que importa: sin la cabecera no hay comprobación
      // previa, y con `arrayBuffer()` el cuerpo entero entraba en memoria
      // ANTES de medirlo. El check detectaba, no defendía.
      mockFetch(mediaResponse(4 * 1024 * 1024, { declared: null, stream: true }));

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        AudioTooLongError,
      );
    });

    it('con stream no se usa arrayBuffer, que es el camino sin cota', async () => {
      const res = mediaResponse(4 * 1024 * 1024, { declared: null, stream: true });
      mockFetch(res);

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toThrow();
      expect(res.arrayBuffer).not.toHaveBeenCalled();
    });

    it('un content-length que no es número tampoco desactiva el tope', async () => {
      // `Number('cualquier-cosa')` es NaN, y una comparación con NaN es false.
      const res = mediaResponse(4 * 1024 * 1024, { stream: true });
      res.headers.set('content-length', 'no-es-un-numero');
      mockFetch(res);

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        AudioTooLongError,
      );
    });
  });

  describe('contenido de la respuesta', () => {
    it('lo que no es audio no se manda al proveedor', async () => {
      mockFetch(mediaResponse(1000, { type: 'application/json' }));

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
      expect(calls).toHaveLength(1);
    });

    it('la transcripción se acota igual que el texto que entra por el webhook', async () => {
      mockFetch(mediaResponse(1000), openaiResponse({ text: 'x'.repeat(9000) }));

      const out = await service.transcribe(MEDIA, CLINIC);
      expect(out.text).toHaveLength(SttService.MAX_TEXT_CHARS);
    });

    it('un timeout del proveedor sale como fallo de infraestructura, no crudo', async () => {
      // Un `DOMException/AbortError` sin envolver no lo sabe clasificar el
      // caller: no distinguiría "reintenta" de "respóndele al paciente".
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        calls.push(String(url));
        if (calls.length === 1) return mediaResponse(1000);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }) as unknown as typeof fetch;

      await expect(service.transcribe(MEDIA, CLINIC)).rejects.toBeInstanceOf(
        SttUnavailableError,
      );
    });
  });
});
