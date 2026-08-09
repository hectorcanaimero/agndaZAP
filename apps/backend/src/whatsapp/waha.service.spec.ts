import { Logger } from '@nestjs/common';
import { WahaService } from './waha.service';

/**
 * Tests unit para las primitivas nuevas del WahaService:
 *  - logoutSession
 *  - getQrCode
 *  - startSession (consistency fix T3: ahora tira Error en !res.ok, mirroring
 *    el patron de sendText y logoutSession).
 *
 * `WahaService` lee `WAHA_BASE_URL` y `WAHA_API_KEY` en el constructor,
 * asi que seteamos el env ANTES de instanciar en cada test.
 */

const BASE_URL = 'http://waha:3000';
const API_KEY = 'test-key';

describe('WahaService (primitives)', () => {
  let svc: WahaService;
  const originalBaseUrl = process.env.WAHA_BASE_URL;
  const originalApiKey = process.env.WAHA_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.WAHA_BASE_URL = BASE_URL;
    process.env.WAHA_API_KEY = API_KEY;
    svc = new WahaService();
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.WAHA_BASE_URL;
    } else {
      process.env.WAHA_BASE_URL = originalBaseUrl;
    }
    if (originalApiKey === undefined) {
      delete process.env.WAHA_API_KEY;
    } else {
      process.env.WAHA_API_KEY = originalApiKey;
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // ─────────────────────────── startSession ───────────────────────────

  describe('startSession', () => {
    it('non-ok: fetch responde 500 → rechaza con Error("WAHA startSession 500")', async () => {
      // Consistency fix (T3): startSession originalmente no verificaba `!res.ok`,
      // lo que dejaba al controller sin poder distinguir un WAHA caido de un
      // start exitoso. Alineamos el comportamiento con sendText y logoutSession.
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(svc.startSession('clinic-abc')).rejects.toThrow(
        /WAHA startSession 500/,
      );
    });
  });

  // ─────────────────────────── logoutSession ───────────────────────────

  describe('logoutSession', () => {
    it('happy path: POST a /api/sessions/{session}/logout con X-Api-Key y resuelve', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(svc.logoutSession('clinic-abc')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/sessions/clinic-abc/logout`);
      expect((init as any).method).toBe('POST');
      expect((init as any).headers['X-Api-Key']).toBe(API_KEY);
    });

    it('non-ok: fetch responde 500 → rechaza con Error("WAHA logout 500")', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(svc.logoutSession('clinic-abc')).rejects.toThrow(
        /WAHA logout 500/,
      );
    });
  });

  // ─────────────────────────── getQrCode ───────────────────────────

  describe('getQrCode', () => {
    it('happy path: GET a /api/{session}/auth/qr con Accept JSON → data URL base64', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ mimetype: 'image/png', data: 'AAAA' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const qr = await svc.getQrCode('clinic-abc');

      expect(qr).toBe('data:image/png;base64,AAAA');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/clinic-abc/auth/qr`);
      // fetch por defecto usa GET cuando no se especifica method (undefined es aceptable),
      // pero preferimos ser explicitos.
      const method = (init as any).method ?? 'GET';
      expect(method).toBe('GET');
      expect((init as any).headers['X-Api-Key']).toBe(API_KEY);
      expect((init as any).headers['Accept']).toBe('application/json');
    });

    it('404: WAHA responde 404 (sesion no en SCAN_QR_CODE) → null, no throw', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      }) as unknown as typeof fetch;

      const qr = await svc.getQrCode('clinic-abc');
      expect(qr).toBeNull();
    });

    it('500: WAHA responde 500 → null (defensivo, sin cachear errores)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      }) as unknown as typeof fetch;

      const qr = await svc.getQrCode('clinic-abc');
      expect(qr).toBeNull();
    });

    it('empty data: WAHA responde 200 con data:"" → null', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ mimetype: 'image/png', data: '' }),
      }) as unknown as typeof fetch;

      const qr = await svc.getQrCode('clinic-abc');
      expect(qr).toBeNull();
    });

    it('missing mimetype: default a image/png', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: 'AAAA' }),
      }) as unknown as typeof fetch;

      const qr = await svc.getQrCode('clinic-abc');
      expect(qr).toBe('data:image/png;base64,AAAA');
    });

    it('nunca loguea el data base64 del QR (PII/secret hygiene)', async () => {
      const secretData = 'AAAABBBB_super_secret_qr_payload';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ mimetype: 'image/png', data: secretData }),
      }) as unknown as typeof fetch;

      const logSpy = jest.spyOn(Logger.prototype, 'log');
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      const debugSpy = jest.spyOn(Logger.prototype, 'debug');
      const verboseSpy = jest.spyOn(Logger.prototype, 'verbose');

      const qr = await svc.getQrCode('clinic-abc');
      expect(qr).toContain(secretData); // el data URL sí contiene el base64

      for (const spy of [logSpy, errorSpy, warnSpy, debugSpy, verboseSpy]) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            const serialized =
              typeof arg === 'string' ? arg : JSON.stringify(arg);
            expect(serialized).not.toContain(secretData);
          }
        }
      }
    });
  });
});
