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
