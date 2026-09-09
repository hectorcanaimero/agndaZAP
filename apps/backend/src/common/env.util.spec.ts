import { validateProdEnv } from './env.util';

const base = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  WAHA_BASE_URL: 'http://waha',
  WAHA_API_KEY: 'k',
  CORS_ORIGINS: 'https://app.example.com',
  JWT_SECRET: 'a'.repeat(48),
  SENTRY_DSN: 'https://sentry',
  WEBHOOK_TOKEN: 't'.repeat(32),
};

describe('validateProdEnv', () => {
  it('env completo → sin errores', () => {
    expect(validateProdEnv(base)).toEqual([]);
  });

  it('lista las env vars base faltantes', () => {
    const { DATABASE_URL: _d, SENTRY_DSN: _s, ...rest } = base;
    const errors = validateProdEnv(rest);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('DATABASE_URL');
    expect(errors[0]).toContain('SENTRY_DSN');
  });

  it('JWT_SECRET corto o con prefijo dev- → error', () => {
    expect(validateProdEnv({ ...base, JWT_SECRET: 'short' })).toEqual([
      expect.stringContaining('32 caracteres'),
    ]);
    expect(
      validateProdEnv({ ...base, JWT_SECRET: 'dev-' + 'a'.repeat(40) }),
    ).toEqual([expect.stringContaining('dev-')]);
  });

  it('WEBHOOK_TOKEN corto o placeholder (dev-/cambiar-) → error', () => {
    expect(validateProdEnv({ ...base, WEBHOOK_TOKEN: 'short' })).toEqual([
      expect.stringContaining('WEBHOOK_TOKEN debe tener al menos 32'),
    ]);
    expect(
      validateProdEnv({ ...base, WEBHOOK_TOKEN: 'cambiar-por-token-hex-de-32-caracteres' }),
    ).toEqual([expect.stringContaining('prefijo "cambiar-"')]);
    expect(
      validateProdEnv({ ...base, WEBHOOK_TOKEN: 'dev-' + 'x'.repeat(40) }),
    ).toEqual([expect.stringContaining('WEBHOOK_TOKEN no puede tener prefijo "dev-"')]);
  });

  it('WEBHOOK_HMAC_SECRET corto o placeholder → error', () => {
    expect(
      validateProdEnv({ ...base, WEBHOOK_HMAC_SECRET: 'short' }),
    ).toEqual([expect.stringContaining('WEBHOOK_HMAC_SECRET debe tener al menos 32')]);
    expect(
      validateProdEnv({ ...base, WEBHOOK_HMAC_SECRET: 'cambiar-' + 'x'.repeat(40) }),
    ).toEqual([expect.stringContaining('WEBHOOK_HMAC_SECRET no puede tener prefijo "cambiar-"')]);
  });

  it('JWT_SECRET con prefijo cambiar- (placeholder de .env.example) → error', () => {
    expect(
      validateProdEnv({ ...base, JWT_SECRET: 'cambiar-por-secreto-de-al-menos-32-caracteres' }),
    ).toEqual([expect.stringContaining('JWT_SECRET no puede tener prefijo "cambiar-"')]);
  });

  it('sin WEBHOOK_HMAC_SECRET ni WEBHOOK_TOKEN → error', () => {
    const { WEBHOOK_TOKEN: _t, ...rest } = base;
    expect(validateProdEnv(rest)).toEqual([
      expect.stringContaining('WEBHOOK_HMAC_SECRET o WEBHOOK_TOKEN'),
    ]);
  });

  it('con sólo WEBHOOK_HMAC_SECRET alcanza (token opcional)', () => {
    const { WEBHOOK_TOKEN: _t, ...rest } = base;
    expect(
      validateProdEnv({ ...rest, WEBHOOK_HMAC_SECRET: 's'.repeat(48) }),
    ).toEqual([]);
  });

  it('ALLOW_WEBHOOK_WITHOUT_TOKEN=true NO relaja el check y es error en prod', () => {
    const { WEBHOOK_TOKEN: _t, ...rest } = base;
    const errors = validateProdEnv({
      ...rest,
      ALLOW_WEBHOOK_WITHOUT_TOKEN: 'true',
    });
    expect(errors).toEqual([
      expect.stringContaining('WEBHOOK_HMAC_SECRET o WEBHOOK_TOKEN'),
      expect.stringContaining('ALLOW_WEBHOOK_WITHOUT_TOKEN'),
    ]);
  });
});
