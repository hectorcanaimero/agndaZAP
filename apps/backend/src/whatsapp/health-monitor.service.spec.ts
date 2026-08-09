import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from './waha.service';
import { WahaHealthMonitor } from './health-monitor.service';

/**
 * Tests unit para WahaHealthMonitor.
 *
 * Estrategia:
 *  - Mock de `PrismaService` (solo `clinic.findMany`) y de `WahaService.getSessionStatus`.
 *  - Spy sobre `Logger.prototype.warn` / `.info` / `.error` para validar el shape
 *    estructurado de los logs sin ensuciar stdout.
 *
 * Reglas del servicio validadas aqui:
 *  1. `warn` solo cuando `status === 'FAILED'`.
 *  2. `STOPPED` y `UNKNOWN` son estados validos/transitorios → no warn.
 *  3. Si `getSessionStatus` tira, se loguea `error` y el loop sigue.
 *  4. Cero PII: nunca aparecen `name`, `phone` o `address` en ningun log.
 *  5. Emite `info` con `event: 'waha.health.tick'` y `count` al arrancar.
 */
describe('WahaHealthMonitor', () => {
  let monitor: WahaHealthMonitor;
  let prisma: { clinic: { findMany: jest.Mock } };
  let waha: { getSessionStatus: jest.Mock };

  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      clinic: {
        findMany: jest.fn(),
      },
    };
    waha = {
      getSessionStatus: jest.fn(),
    };
    monitor = new WahaHealthMonitor(
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
    );

    // Espia todos los niveles del Logger para poder auditar cualquier fuga PII.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('3 clinicas mix (WORKING, FAILED, STOPPED) → 1 warn solo por la FAILED', async () => {
    prisma.clinic.findMany.mockResolvedValue([
      { id: 'clinic-a', wahaSession: 'session-a' },
      { id: 'clinic-b', wahaSession: 'session-b' },
      { id: 'clinic-c', wahaSession: 'session-c' },
    ]);
    waha.getSessionStatus
      .mockResolvedValueOnce('WORKING')
      .mockResolvedValueOnce('FAILED')
      .mockResolvedValueOnce('STOPPED');

    const result = await monitor.checkAll();

    expect(waha.getSessionStatus).toHaveBeenCalledTimes(3);
    expect(waha.getSessionStatus).toHaveBeenNthCalledWith(1, 'session-a');
    expect(waha.getSessionStatus).toHaveBeenNthCalledWith(2, 'session-b');
    expect(waha.getSessionStatus).toHaveBeenNthCalledWith(3, 'session-c');

    // Exactamente 1 warn, y es la FAILED.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'waha.health.failed',
        clinicId: 'clinic-b',
        session: 'session-b',
      }),
    );

    // Tick log con count === 3.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'waha.health.tick', count: 3 }),
    );

    expect(result).toEqual({ checked: 3, failed: 1 });
  });

  it('1 clinica en UNKNOWN → cero warns', async () => {
    prisma.clinic.findMany.mockResolvedValue([
      { id: 'clinic-a', wahaSession: 'session-a' },
    ]);
    waha.getSessionStatus.mockResolvedValueOnce('UNKNOWN');

    const result = await monitor.checkAll();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, failed: 0 });
  });

  it('getSessionStatus tira en 1 clinica → loguea error y sigue el loop', async () => {
    prisma.clinic.findMany.mockResolvedValue([
      { id: 'clinic-a', wahaSession: 'session-a' },
      { id: 'clinic-b', wahaSession: 'session-b' },
      { id: 'clinic-c', wahaSession: 'session-c' },
    ]);
    waha.getSessionStatus
      .mockResolvedValueOnce('WORKING')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('FAILED');

    const result = await monitor.checkAll();

    // El error se loguea exactamente una vez con el clinicId ofensor.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'waha.health.error',
        clinicId: 'clinic-b',
        session: 'session-b',
        err: 'boom',
      }),
    );

    // El warn para clinic-c prueba que el loop no se aborto.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'waha.health.failed',
        clinicId: 'clinic-c',
      }),
    );

    // "checked" cuenta intentos (el error tambien es un intento).
    // "failed" solo cuenta status === 'FAILED'.
    expect(result).toEqual({ checked: 3, failed: 1 });
  });

  it('sin clinicas → { checked: 0, failed: 0 } y sigue emitiendo el tick', async () => {
    prisma.clinic.findMany.mockResolvedValue([]);

    const result = await monitor.checkAll();

    expect(waha.getSessionStatus).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'waha.health.tick', count: 0 }),
    );
    expect(result).toEqual({ checked: 0, failed: 0 });
  });

  it('PII guard: name/phone/address NUNCA aparecen en ningun log (load-bearing)', async () => {
    const PII_NAME = 'MI SECRETO PII';
    const PII_PHONE = '+5811123';
    const PII_ADDRESS = 'X';

    // La clinica trae PII en su payload — el servicio solo puede leer id + session.
    // Si en el futuro alguien agrega name/phone/address al select o al log, este
    // test se cae. Esa es la unica proteccion en runtime del "cero PII" del ADR.
    prisma.clinic.findMany.mockResolvedValue([
      {
        id: 'clinic-1',
        wahaSession: 'session-1',
        name: PII_NAME,
        phone: PII_PHONE,
        address: PII_ADDRESS,
      },
    ]);
    waha.getSessionStatus.mockResolvedValueOnce('FAILED');

    await monitor.checkAll();

    const allSpies = [warnSpy, infoSpy, errorSpy, debugSpy, logSpy];
    for (const spy of allSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          const serialized =
            typeof arg === 'string' ? arg : JSON.stringify(arg);
          expect(serialized).not.toContain(PII_NAME);
          expect(serialized).not.toContain(PII_PHONE);
          expect(serialized).not.toContain(PII_ADDRESS);
        }
      }
    }
  });
});
