import { BadRequestException, Logger } from '@nestjs/common';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from './waha.service';
import { WhatsappPanelController } from './whatsapp-panel.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

/**
 * Tests unit del WhatsappPanelController (T2 — bloque WAHA panel).
 *
 * Ver:
 *  - docs/notas/2026-08-09-bloque-waha-panel-conexion.md (contratos y escenarios).
 *  - docs/notas/2026-08-09-plan-bloque-waha-panel-conexion.md (T2, Q3, §8).
 *
 * Reglas duras cubiertas aca:
 *  - `session` proviene SIEMPRE de clinic.wahaSession (nunca del request).
 *  - `assertClinicScope(user)` sin override → SUPERADMIN da 400 (contradiccion
 *    resuelta en §8 del plan; se mantiene el ADR).
 *  - Cuando status !== 'SCAN_QR_CODE', NO se pide QR ni se incluye en response.
 *  - Cuando status === 'SCAN_QR_CODE' y `getQrCode` devuelve null, la response
 *    no incluye la clave `qr` (contrato: qr opcional).
 *  - PII hygiene: el logger nunca recibe el string del QR, solo 'present' o
 *    'absent'.
 */
describe('WhatsappPanelController — GET /status', () => {
  let prisma: Deep<PrismaService>;
  let waha: Deep<WahaService>;
  let controller: WhatsappPanelController;

  const adminA: AuthUser = {
    userId: 'user-A',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const superadmin: AuthUser = {
    userId: 'u-super',
    clinicId: null,
    role: 'SUPERADMIN',
  };

  const clinicASession = 'clinic-a-session';

  beforeEach(() => {
    prisma = {
      clinic: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ wahaSession: clinicASession }),
      },
    };
    waha = {
      getSessionStatus: jest.fn(),
      getQrCode: jest.fn(),
    };
    controller = new WhatsappPanelController(
      waha as unknown as WahaService,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('CLINIC_ADMIN + status WORKING → devuelve status y session, sin qr', async () => {
    waha.getSessionStatus.mockResolvedValue('WORKING');

    const result = await controller.status(adminA);

    expect(result).toEqual({ status: 'WORKING', session: clinicASession });
    expect('qr' in result).toBe(false);

    expect(prisma.clinic.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'clinic-A' },
      select: { wahaSession: true },
    });
    expect(waha.getSessionStatus).toHaveBeenCalledWith(clinicASession);
    // Regla dura: si el status no exige QR, NUNCA consultar el QR.
    expect(waha.getQrCode).not.toHaveBeenCalled();
  });

  it('CLINIC_ADMIN + status SCAN_QR_CODE → adjunta qr (data URL)', async () => {
    waha.getSessionStatus.mockResolvedValue('SCAN_QR_CODE');
    waha.getQrCode.mockResolvedValue('data:image/png;base64,AAAA');

    const result = await controller.status(adminA);

    expect(result).toEqual({
      status: 'SCAN_QR_CODE',
      session: clinicASession,
      qr: 'data:image/png;base64,AAAA',
    });
    expect(waha.getQrCode).toHaveBeenCalledTimes(1);
    expect(waha.getQrCode).toHaveBeenCalledWith(clinicASession);
  });

  it('SUPERADMIN sin override → 400 y no toca Prisma ni WAHA', async () => {
    // Contradicción resuelta en §8 del plan: SUPERADMIN sin clinicId explícito
    // se rechaza con 400 (por assertClinicScope). No happy path aquí.
    await expect(controller.status(superadmin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.clinic.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(waha.getSessionStatus).not.toHaveBeenCalled();
    expect(waha.getQrCode).not.toHaveBeenCalled();
  });

  it('WAHA down (getSessionStatus retorna UNKNOWN) → status UNKNOWN sin throw ni qr', async () => {
    waha.getSessionStatus.mockResolvedValue('UNKNOWN');

    const result = await controller.status(adminA);

    expect(result).toEqual({ status: 'UNKNOWN', session: clinicASession });
    expect('qr' in result).toBe(false);
    // UNKNOWN nunca dispara consulta de QR (evita amplificar fallos de WAHA).
    expect(waha.getQrCode).not.toHaveBeenCalled();
  });

  it('SCAN_QR_CODE pero getQrCode → null: response sin qr y log debug "absent"', async () => {
    waha.getSessionStatus.mockResolvedValue('SCAN_QR_CODE');
    waha.getQrCode.mockResolvedValue(null);

    const debugSpy = jest.spyOn(Logger.prototype, 'debug');

    const result = await controller.status(adminA);

    // Contrato: qr es opcional. Con null NO se serializa la clave.
    expect(result).toEqual({
      status: 'SCAN_QR_CODE',
      session: clinicASession,
    });
    expect('qr' in result).toBe(false);

    // Verificamos que se emitió al menos un debug con qr:'absent' y que NUNCA
    // se logueó el string real del QR (contrato PII).
    const debugCalls = debugSpy.mock.calls;
    expect(debugCalls.length).toBeGreaterThan(0);
    const flat = debugCalls
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' | ');
    expect(flat).toContain('absent');
    expect(flat).not.toContain('present');
  });
});
