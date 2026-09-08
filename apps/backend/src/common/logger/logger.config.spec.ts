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
