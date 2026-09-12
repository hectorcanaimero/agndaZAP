import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  claimSttBudget,
  STT_DAILY_LIMIT_DEFAULT,
  STT_DAILY_LIMIT_PER_CHAT,
  sttDailyLimit,
  sttQuotaKeys,
  utcDay,
  withinSttBudget,
} from './stt-budget';

/**
 * Cota diaria de transcripciones (S38). El rate-limit del ADR 0007 es
 * fail-open a propósito; esta cota es lo contrario, porque equivocarse aquí se
 * paga en dinero y en grabaciones de pacientes saliendo hacia un tercero.
 */
describe('presupuesto de STT', () => {
  let logger: Logger;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const params = { clinicId: 'clinic-A', chatId: '584141234567@c.us' };

  beforeEach(() => {
    logger = new Logger('test');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    delete process.env.STT_DAILY_LIMIT;
    process.env.LOG_HASH_SECRET = 'secreto-de-test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STT_DAILY_LIMIT;
  });

  /** Redis que cuenta de verdad, para poder ejercer la cota como un caller. */
  function fakeRedis() {
    const store = new Map<string, number>();
    const ttls: Array<[string, number, string]> = [];
    const redis = {
      mget: jest.fn(async (...keys: string[]) =>
        keys.map((k) => (store.has(k) ? String(store.get(k)) : null)),
      ),
      pipeline: jest.fn(() => {
        const ops: Array<[Error | null, unknown]> = [];
        const chain: Record<string, unknown> = {};
        chain.incr = jest.fn((k: string) => {
          const n = (store.get(k) ?? 0) + 1;
          store.set(k, n);
          ops.push([null, n]);
          return chain;
        });
        chain.expire = jest.fn((k: string, ttl: number, mode: string) => {
          ttls.push([k, ttl, mode]);
          ops.push([null, 1]);
          return chain;
        });
        chain.exec = jest.fn(async () => ops);
        return chain;
      }),
    };
    return { redis: redis as unknown as Redis, store, ttls };
  }

  describe('sttDailyLimit', () => {
    it('sin env, el default del piloto', () => {
      expect(sttDailyLimit()).toBe(STT_DAILY_LIMIT_DEFAULT);
    });

    it.each(['doscientos', '0x10', '1e3', '-5', '10.5'])(
      'un env inválido (%s) avisa y NO cambia el tope',
      (raw) => {
        // `Number('0x10')` son 16 y `Number('1e3')` son 1000: una errata en
        // Coolify subiría el tope en silencio en vez de avisar. Y un `NaN`
        // leído como 0 apagaría la transcripción de todas las clínicas, que
        // parecería un bug del feature y no una errata de configuración.
        process.env.STT_DAILY_LIMIT = raw;

        expect(sttDailyLimit(logger)).toBe(STT_DAILY_LIMIT_DEFAULT);
        expect(warn).toHaveBeenCalled();
      },
    );

    it('un cero explícito sí apaga: es una decisión, no una errata', () => {
      process.env.STT_DAILY_LIMIT = '0';
      expect(sttDailyLimit(logger)).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('las claves', () => {
    it('el día es UTC, no el de la clínica', () => {
      // La TZ la edita el propio tenant (`PATCH /api/clinics/me`): con la fecha
      // local dentro de la clave, rotar la zona genera claves nuevas y triplica
      // la cota. Un control de gasto que el controlado puede reiniciar no lo es.
      expect(utcDay(Date.UTC(2026, 8, 13, 2, 0, 0))).toBe('2026-09-13');
    });

    it('cada clínica cuenta en su propia clave', () => {
      const a = sttQuotaKeys('clinic-A', params.chatId);
      const b = sttQuotaKeys('clinic-B', params.chatId);
      expect(a.clinicKey).not.toBe(b.clinicKey);
      // Y el mismo paciente escribiendo a dos clínicas tampoco se mezcla.
      expect(a.chatKey).not.toBe(b.chatKey);
    });

    it('el chat va hasheado: un teléfono en claro en Redis es PII', () => {
      const { chatKey } = sttQuotaKeys('clinic-A', params.chatId);
      expect(chatKey).not.toContain('584141234567');
    });

    it('un clinicId con `:` no rompe el namespace', () => {
      const { clinicKey } = sttQuotaKeys('clinic:A:evil', params.chatId);
      expect(clinicKey.split(':')).toHaveLength(4);
    });
  });

  describe('withinSttBudget', () => {
    it('sin nada consumido, hay presupuesto', async () => {
      const { redis } = fakeRedis();
      await expect(withinSttBudget(redis, logger, params)).resolves.toBe('ok');
    });

    it('justo en el límite de la clínica ya no', async () => {
      process.env.STT_DAILY_LIMIT = '10';
      const { redis, store } = fakeRedis();
      store.set(sttQuotaKeys(params.clinicId, params.chatId).clinicKey, 10);

      await expect(withinSttBudget(redis, logger, params)).resolves.toBe(
        'agotado',
      );
    });

    it('un chat que agotó lo suyo no consume la cota de la clínica', async () => {
      // Sin la sub-cota, un solo número quema los 200 del día en ~14 minutos:
      // la clínica paga las transcripciones del atacante y sus pacientes
      // reales se quedan sin el feature el resto del día.
      const { redis, store } = fakeRedis();
      const { chatKey, clinicKey } = sttQuotaKeys(params.clinicId, params.chatId);
      store.set(chatKey, STT_DAILY_LIMIT_PER_CHAT);

      await expect(withinSttBudget(redis, logger, params)).resolves.toBe(
        'agotado',
      );
      expect(store.get(clinicKey)).toBeUndefined();
    });

    it('con Redis mudo NO dice "agotado": dice "indeterminado"', async () => {
      // La diferencia decide si al paciente se le fuerza el aviso. Tratarlo
      // como agotado lo dejaría sin transcripción Y sin respuesta, porque el
      // throttle del aviso vive en el mismo Redis que acaba de fallar.
      const redis = {
        mget: jest.fn().mockRejectedValue(new Error('redis down')),
      } as unknown as Redis;

      await expect(withinSttBudget(redis, logger, params)).resolves.toBe(
        'indeterminado',
      );
    });
  });

  describe('claimSttBudget', () => {
    it('reserva y fija el TTL una sola vez (NX)', async () => {
      const { redis, store, ttls } = fakeRedis();
      const { clinicKey } = sttQuotaKeys(params.clinicId, params.chatId);

      await expect(claimSttBudget(redis, logger, params)).resolves.toBe(true);

      expect(store.get(clinicKey)).toBe(1);
      // Sin `NX`, una clínica activa arrastraría el contador de ayer.
      expect(ttls.every(([, , mode]) => mode === 'NX')).toBe(true);
    });

    it('el límite es exacto: la número 10 entra, la 11 no', async () => {
      process.env.STT_DAILY_LIMIT = '10';
      const { redis } = fakeRedis();

      const resultados: boolean[] = [];
      for (let i = 0; i < 11; i++) {
        resultados.push(await claimSttBudget(redis, logger, params));
      }

      expect(resultados.filter(Boolean)).toHaveLength(10);
      expect(resultados[10]).toBe(false);
    });

    it('si la escritura falla, NO se transcribe', async () => {
      // El caso real: disco lleno con `stop-writes-on-bgsave-error yes` (el
      // default). Redis sigue sirviendo lecturas y rechaza escrituras, así que
      // un contador leído con GET se quedaba congelado y la cota quedaba
      // desactivada en silencio, gastando dinero.
      const redis = {
        pipeline: () => ({
          incr: jest.fn().mockReturnThis(),
          expire: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([[new Error('MISCONF'), null]]),
        }),
      } as unknown as Redis;

      await expect(claimSttBudget(redis, logger, params)).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('MISCONF'));
    });

    it('con el límite en 0 no se reserva nada, ni se toca Redis', async () => {
      process.env.STT_DAILY_LIMIT = '0';
      const { redis, store } = fakeRedis();

      await expect(claimSttBudget(redis, logger, params)).resolves.toBe(false);
      expect(store.size).toBe(0);
    });
  });
});
