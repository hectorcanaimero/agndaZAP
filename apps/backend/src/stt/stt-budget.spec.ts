import { Logger } from '@nestjs/common';
import { Settings } from 'luxon';
import {
  consumeSttBudget,
  STT_DAILY_LIMIT_DEFAULT,
  sttDailyLimit,
  sttQuotaKey,
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

  beforeEach(() => {
    logger = new Logger('test');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    delete process.env.STT_DAILY_LIMIT;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STT_DAILY_LIMIT;
    Settings.now = () => Date.now();
  });

  describe('sttDailyLimit', () => {
    it('sin env, el default del piloto', () => {
      expect(sttDailyLimit()).toBe(STT_DAILY_LIMIT_DEFAULT);
    });

    it('un env inválido avisa y NO apaga la transcripción', () => {
      // `Number('doscientos')` es NaN y un `!limite` lo leería como 0, que
      // dejaría a todas las clínicas sin notas de voz — y parecería un bug del
      // feature, no una errata en Coolify.
      process.env.STT_DAILY_LIMIT = 'doscientos';

      expect(sttDailyLimit(logger)).toBe(STT_DAILY_LIMIT_DEFAULT);
      expect(warn).toHaveBeenCalled();
    });

    it('un cero explícito sí apaga: es una decisión, no una errata', () => {
      process.env.STT_DAILY_LIMIT = '0';
      expect(sttDailyLimit(logger)).toBe(0);
    });
  });

  describe('sttQuotaKey', () => {
    it('el día es el de la clínica, no el del proceso', () => {
      // 02:00 UTC del día 13 son las 22:00 del 12 en Caracas. El backend corre
      // en UTC: con la zona del proceso, una clínica venezolana vería su cota
      // reiniciarse a las 20:00, en plena tarde de consulta.
      Settings.now = () => Date.UTC(2026, 8, 13, 2, 0, 0);

      expect(sttQuotaKey('clinic-A', 'America/Caracas')).toContain('2026-09-12');
      expect(sttQuotaKey('clinic-A', 'UTC')).toContain('2026-09-13');
    });
  });

  describe('withinSttBudget', () => {
    const params = { clinicId: 'clinic-A', timezone: 'America/Caracas' };

    it('sin nada consumido, hay presupuesto', async () => {
      const redis = { get: jest.fn().mockResolvedValue(null) } as never;
      await expect(withinSttBudget(redis, logger, params)).resolves.toBe(true);
    });

    it('justo en el límite ya no', async () => {
      process.env.STT_DAILY_LIMIT = '10';
      const redis = { get: jest.fn().mockResolvedValue('10') } as never;
      await expect(withinSttBudget(redis, logger, params)).resolves.toBe(false);
    });

    it('con Redis caído NO se transcribe (fail-closed)', async () => {
      // Al revés que el rate-limit del ADR 0007, que ante la duda deja pasar.
      const redis = {
        get: jest.fn().mockRejectedValue(new Error('redis down')),
      } as never;

      await expect(withinSttBudget(redis, logger, params)).resolves.toBe(false);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('consumeSttBudget', () => {
    const params = { clinicId: 'clinic-A', timezone: 'America/Caracas' };

    function fakeRedis(results: [Error | null, unknown][]) {
      const pipe = {
        incr: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(results),
      };
      return { redis: { pipeline: () => pipe } as never, pipe };
    }

    it('incrementa y fija el TTL una sola vez (NX)', async () => {
      const { redis, pipe } = fakeRedis([
        [null, 1],
        [null, 1],
      ]);

      await consumeSttBudget(redis, logger, params);

      expect(pipe.incr).toHaveBeenCalledWith(
        sttQuotaKey('clinic-A', 'America/Caracas'),
      );
      // Sin `NX`, una clínica activa arrastraría el contador de ayer.
      expect(pipe.expire).toHaveBeenCalledWith(expect.any(String), 172_800, 'NX');
    });

    it('un comando fallido del pipeline no pasa desapercibido', async () => {
      // `exec()` NO rechaza por errores de comandos sueltos: los devuelve
      // dentro del array. Sin mirarlos, el contador se queda clavado en cero y
      // la cota deja de contar, en silencio.
      const { redis } = fakeRedis([[new Error('WRONGTYPE'), null]]);

      await consumeSttBudget(redis, logger, params);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WRONGTYPE'));
    });
  });
});
