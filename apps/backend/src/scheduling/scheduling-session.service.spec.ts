import type Redis from 'ioredis';
import {
  SchedulingSessionService,
  type SchedulingSessionData,
} from './scheduling-session.service';

/**
 * Redis mock: mapa en memoria con TTL ignorado (los tests no simulan expiración
 * — para eso existiría un test de integración con `ioredis-mock` o Redis real).
 * Emula lo mínimo que consume el service: get / set / del / pipeline().
 */
function makeRedisMock() {
  const store = new Map<string, string>();
  const api = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, _mode?: string, _ttl?: number) => {
        store.set(key, value);
        return 'OK';
      },
    ),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    pipeline: jest.fn(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const pipe: any = {
        get: (key: string) => {
          ops.push(() => Promise.resolve(store.get(key) ?? null));
          return pipe;
        },
        del: (key: string) => {
          ops.push(() => Promise.resolve(store.delete(key) ? 1 : 0));
          return pipe;
        },
        exec: async () => {
          const results: Array<[Error | null, unknown]> = [];
          for (const op of ops) {
            results.push([null, await op()]);
          }
          return results;
        },
      };
      return pipe;
    }),
    _store: store,
  };
  return api;
}

function baseInput(
  overrides: Partial<Omit<SchedulingSessionData, 'createdAtISO'>> = {},
) {
  return {
    conversationId: 'conv-1',
    clinicId: 'clinic-A',
    clinicSlug: 'clinica-a',
    phone: '+5804141234567',
    lid: null,
    name: 'Juan Pérez',
    ...overrides,
  };
}

describe('SchedulingSessionService', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let service: SchedulingSessionService;

  beforeEach(() => {
    redis = makeRedisMock();
    service = new SchedulingSessionService(redis as unknown as Redis);
  });

  describe('create', () => {
    it('genera un token URL-safe y persiste el payload con TTL', async () => {
      const { token, expiresInSeconds } = await service.create(baseInput());

      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(20);
      expect(expiresInSeconds).toBe(30 * 60);
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, mode, ttl] = redis.set.mock.calls[0];
      expect(key).toBe(`sched:sess:${token}`);
      expect(mode).toBe('EX');
      expect(ttl).toBe(30 * 60);
      const parsed = JSON.parse(value as string);
      expect(parsed.conversationId).toBe('conv-1');
      expect(parsed.createdAtISO).toEqual(expect.any(String));
    });

    it('acepta ttl custom', async () => {
      await service.create(baseInput(), 60);
      const [, , , ttl] = redis.set.mock.calls[0];
      expect(ttl).toBe(60);
    });

    it('genera tokens distintos en cada invocación', async () => {
      const a = await service.create(baseInput());
      const b = await service.create(baseInput());
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('resolve', () => {
    it('devuelve el payload sin borrar el token', async () => {
      const { token } = await service.create(baseInput());
      const first = await service.resolve(token);
      const second = await service.resolve(token);

      expect(first?.conversationId).toBe('conv-1');
      expect(second?.conversationId).toBe('conv-1');
    });

    it('devuelve null para token inexistente', async () => {
      const result = await service.resolve('nonExistentTokenValue123456');
      expect(result).toBeNull();
    });

    it('devuelve null para token con caracteres inválidos (no hit a Redis)', async () => {
      const result = await service.resolve('tok con espacios!!');
      expect(result).toBeNull();
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('devuelve null si el valor en Redis está corrupto', async () => {
      redis._store.set('sched:sess:corruptTokenExampleAAAA', 'not-json{{{');
      const result = await service.resolve('corruptTokenExampleAAAA');
      expect(result).toBeNull();
    });
  });

  describe('consume', () => {
    it('devuelve el payload y borra el token', async () => {
      const { token } = await service.create(baseInput());
      const consumed = await service.consume(token);

      expect(consumed?.conversationId).toBe('conv-1');
      const afterConsume = await service.resolve(token);
      expect(afterConsume).toBeNull();
    });

    it('devuelve null en segunda invocación (un token, una cita)', async () => {
      const { token } = await service.create(baseInput());
      await service.consume(token);
      const secondConsume = await service.consume(token);
      expect(secondConsume).toBeNull();
    });

    it('devuelve null para token inexistente', async () => {
      const result = await service.consume('nonExistentTokenValue123456');
      expect(result).toBeNull();
    });

    it('preserva phone=null (caso LID)', async () => {
      const { token } = await service.create(
        baseInput({ phone: null, lid: 'abc123xyz' }),
      );
      const consumed = await service.consume(token);
      expect(consumed?.phone).toBeNull();
      expect(consumed?.lid).toBe('abc123xyz');
    });
  });
});

/**
 * Tokens de gestión de cita (ADR 0020). Espacio de claves distinto al de las
 * sesiones de agendamiento y semántica distinta: no se consumen al leerlos.
 */
describe('SchedulingSessionService — tokens de gestión', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let service: SchedulingSessionService;

  const BASE = {
    appointmentId: 'appt-1',
    clinicId: 'clinic-A',
    clinicSlug: 'demo',
    phone: '+584141234567',
  };

  const in7Days = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  beforeEach(() => {
    redis = makeRedisMock();
    service = new SchedulingSessionService(redis as unknown as Redis);
  });

  it('createManage guarda bajo el prefijo sched:manage: y devuelve un token usable', async () => {
    const { token } = await service.createManage(BASE, in7Days());

    expect(token).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(redis._store.has(`sched:manage:${token}`)).toBe(true);

    const resolved = await service.resolveManage(token);
    expect(resolved).toMatchObject({ ...BASE, kind: 'manage' });
  });

  it('el TTL se deriva de startAt', async () => {
    await service.createManage(BASE, in7Days());

    const ttl = redis.set.mock.calls[0][3] as number;
    // 7 días ± un minuto de holgura por el tiempo de ejecución.
    expect(ttl).toBeGreaterThan(7 * 24 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it('TTL con suelo de 30 min: una cita inminente igual da un link usable', async () => {
    // Cita dentro de 5 minutos → sin suelo el token moriría antes de que el
    // paciente abra el mensaje.
    const { expiresInSeconds } = await service.createManage(
      BASE,
      new Date(Date.now() + 5 * 60 * 1000),
    );
    expect(expiresInSeconds).toBe(30 * 60);
  });

  it('TTL con techo de 30 días: una cita lejana no deja el token vivo meses', async () => {
    const { expiresInSeconds } = await service.createManage(
      BASE,
      new Date(Date.now() + 200 * 24 * 60 * 60 * 1000),
    );
    expect(expiresInSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('una cita ya pasada cae al suelo, no a un TTL negativo', async () => {
    const { expiresInSeconds } = await service.createManage(
      BASE,
      new Date(Date.now() - 60 * 60 * 1000),
    );
    expect(expiresInSeconds).toBe(30 * 60);
  });

  describe('issueManageUrl (única fuente del link de gestión, S21)', () => {
    const appt = {
      id: 'appt-1',
      clinicId: 'clinic-A',
      startAt: new Date(Date.now() + 86_400_000),
    };

    afterEach(() => {
      delete process.env.WEB_BASE_URL;
    });

    it('arma la URL de la página de la cita con el token recién emitido', async () => {
      process.env.WEB_BASE_URL = 'https://showly.us';

      const url = await service.issueManageUrl(appt, 'clinica-a', 'es');

      expect(url).toMatch(
        /^https:\/\/showly\.us\/es\/agendar\/clinica-a\/cita\?t=.+$/,
      );
    });

    it('normaliza el trailing slash de WEB_BASE_URL', async () => {
      process.env.WEB_BASE_URL = 'https://showly.us/';

      const url = await service.issueManageUrl(appt, 'clinica-a', 'pt');

      expect(url).toContain('https://showly.us/pt/agendar/clinica-a/cita?t=');
      expect(url).not.toContain('//pt/');
    });

    it('el token emitido NO guarda PII del paciente', async () => {
      // Viviría hasta 30 días en Redis sin que nadie lo consuma.
      const url = await service.issueManageUrl(appt, 'clinica-a', 'es');
      const token = url.split('?t=')[1];

      const raw = redis._store.get(`sched:manage:${token}`);
      expect(raw).toBeTruthy();
      const payload = JSON.parse(raw as string);
      expect(payload).not.toHaveProperty('phone');
      expect(payload).not.toHaveProperty('name');
      expect(payload.appointmentId).toBe('appt-1');
      expect(payload.clinicId).toBe('clinic-A');
    });
  });

  it('resolveManage NO consume: el paciente puede recargar la página', async () => {
    const { token } = await service.createManage(BASE, in7Days());

    expect(await service.resolveManage(token)).not.toBeNull();
    expect(await service.resolveManage(token)).not.toBeNull();
    expect(redis._store.has(`sched:manage:${token}`)).toBe(true);
  });

  it('invalidateManage borra el token', async () => {
    const { token } = await service.createManage(BASE, in7Days());
    await service.invalidateManage(token);

    expect(await service.resolveManage(token)).toBeNull();
  });

  it('invalidateManage no lanza si Redis falla (la cita ya cambió)', async () => {
    const { token } = await service.createManage(BASE, in7Days());
    redis.del.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.invalidateManage(token)).resolves.toBeUndefined();
  });

  it('un token de agendamiento NO sirve como token de gestión, ni al revés', async () => {
    // Los dos espacios de claves están separados; si alguna vez se unificaran
    // por error, el chequeo de `kind` sigue cortando.
    const { token: schedToken } = await service.create({
      conversationId: 'c-1',
      clinicId: 'clinic-A',
      clinicSlug: 'demo',
      phone: '+584141234567',
      lid: null,
      name: null,
    });
    expect(await service.resolveManage(schedToken)).toBeNull();

    const { token: manageToken } = await service.createManage(BASE, in7Days());
    expect(await service.resolve(manageToken)).toBeNull();
  });

  it('un payload sin kind manage se rechaza aunque esté en la clave correcta', async () => {
    redis._store.set(
      'sched:manage:' + 'x'.repeat(32),
      JSON.stringify({ appointmentId: 'appt-1', clinicSlug: 'demo' }),
    );
    expect(await service.resolveManage('x'.repeat(32))).toBeNull();
  });

  it('token con forma implausible ni siquiera toca Redis', async () => {
    expect(await service.resolveManage('../../etc/passwd')).toBeNull();
    expect(await service.resolveManage('')).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('JSON corrupto degrada a null en vez de romper el endpoint', async () => {
    redis._store.set('sched:manage:' + 'y'.repeat(32), '{no-json');
    expect(await service.resolveManage('y'.repeat(32))).toBeNull();
  });
});
