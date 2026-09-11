import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { pinoConfig } from './logger.config';

type PinoHttpOptions = Options<IncomingMessage, ServerResponse>;

function getConfig(): PinoHttpOptions {
  const config = pinoConfig().pinoHttp;
  if (!config || typeof config === 'boolean' || Array.isArray(config)) {
    throw new Error('pinoHttp config missing');
  }
  return config as PinoHttpOptions;
}

describe('pinoConfig', () => {
  const prevEnv = process.env;

  beforeEach(() => {
    process.env = { ...prevEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = prevEnv;
  });

  it('emite campos HTTP top-level del contrato de observabilidad', () => {
    const config = getConfig();

    const req = {
      id: 'req-1',
      method: 'GET',
      url: '/api/appointments?day=2026-08-23',
      headers: {},
      user: {
        userId: 'user-1',
        clinicId: 'clinic-1',
        impersonatedBy: 'super-1',
      },
    };
    const res = { statusCode: 200 };
    const value = { res, latencyMs: 42 };

    const entry = config.customSuccessObject?.(
      req as never,
      res as never,
      value,
    );

    expect(entry).toMatchObject({
      requestId: 'req-1',
      clinicId: 'clinic-1',
      userId: 'user-1',
      impersonatedBy: 'super-1',
      route: '/api/appointments',
      method: 'GET',
      status: 200,
      latencyMs: 42,
    });
    expect(config.customSuccessMessage?.(req as never, res as never, 42)).toBe(
      'GET /api/appointments',
    );
  });

  it('ignora health checks aunque vengan con query string', () => {
    const config = getConfig();

        if (!config.autoLogging || typeof config.autoLogging === 'boolean') {
      throw new Error('autoLogging ignore missing');
    }

    expect(
      config.autoLogging.ignore?.({
        url: '/api/health?source=betterstack',
      } as never),
    ).toBe(true);
    expect(
      config.autoLogging.ignore?.({
        url: '/api/health/live?source=betterstack',
      } as never),
    ).toBe(true);
    expect(
      config.autoLogging.ignore?.({ url: '/api/appointments' } as never),
    ).toBe(false);
  });
});

/**
 * El token de gestión de cita (ADR 0020) viaja EN LA URL y es una credencial
 * bearer de hasta 30 días: quien la lea puede ver los datos del paciente y
 * cancelar o mover su cita. `pino-http` hace `logger.child({ req })`, así que
 * sin redactar acabaría en cada log del request, y de ahí en Axiom (un
 * tercero), en `docker logs` y en los access logs.
 */
describe('pinoConfig — serializer de req: tokens fuera de los logs', () => {
  const TOKEN = 'Ab3-_xY9zQwErTyUiOpAsDfGhJkL';

  function serializeReq(url: string, referer?: string) {
    const { serializers } = pinoConfig().pinoHttp as any;
    return serializers.req({
      id: 'req-1',
      method: 'GET',
      url,
      headers: { host: 'api.showly.us', 'user-agent': 'x', referer },
    });
  }

  it('redacta el token de gestión de cita', () => {
    const out = serializeReq(
      `/api/public/clinics/demo/appointments/manage/${TOKEN}`,
    );
    expect(out.url).not.toContain(TOKEN);
    expect(out.url).toBe(
      '/api/public/clinics/demo/appointments/manage/[REDACTED]',
    );
  });

  it('redacta también en cancel y reschedule (el token va en medio del path)', () => {
    expect(
      serializeReq(
        `/api/public/clinics/demo/appointments/manage/${TOKEN}/cancel`,
      ).url,
    ).not.toContain(TOKEN);
    expect(
      serializeReq(
        `/api/public/clinics/demo/appointments/manage/${TOKEN}/reschedule`,
      ).url,
    ).not.toContain(TOKEN);
  });

  it('cubre los tokens de sesión de agendamiento y de invitación', () => {
    expect(
      serializeReq(`/api/public/scheduling/session/${TOKEN}`).url,
    ).not.toContain(TOKEN);
    expect(serializeReq(`/api/invitations/${TOKEN}`).url).not.toContain(TOKEN);
  });

  it('corta la query entera: así el token nunca entra por `?t=`', () => {
    const out = serializeReq(`/es/agendar/demo/cita?t=${TOKEN}`);
    expect(out.url).toBe('/es/agendar/demo/cita');
  });

  it('redacta el referer, que es por donde llega la URL de la web', () => {
    const out = serializeReq('/api/public/clinics/demo', `https://showly.us/es/agendar/demo/cita?t=${TOKEN}`);
    expect(out.headers.referer).not.toContain(TOKEN);
  });

  it('no rompe una URL normal ni un referer ausente', () => {
    const out = serializeReq('/api/public/clinics/demo/availability');
    expect(out.url).toBe('/api/public/clinics/demo/availability');
    expect(out.headers.referer).toBeUndefined();
  });
});

