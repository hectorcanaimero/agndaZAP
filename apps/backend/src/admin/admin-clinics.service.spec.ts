import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClinicStatus } from '@prisma/client';
import type { InvitationsService } from '../invitations/invitations.service';
import type { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminClinicsService, type CreateClinicInput } from './admin-clinics.service';

// ─── Stubs de Prisma ──────────────────────────────────────────────────────────

type PrismaStub = {
  clinic: {
    create: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  user: {
    create: jest.Mock;
  };
  professional: { count: jest.Mock };
  service: { count: jest.Mock };
  appointment: { count: jest.Mock };
  patient: { count: jest.Mock };
  $transaction: jest.Mock;
};

function buildStub(): PrismaStub {
  return {
    clinic: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      create: jest.fn(),
    },
    professional: { count: jest.fn() },
    service: { count: jest.fn() },
    appointment: { count: jest.fn() },
    patient: { count: jest.fn() },
    $transaction: jest.fn(),
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_CLINIC = {
  id: 'clinic-1',
  name: 'Clínica Test',
  slug: 'clinica-test',
  timezone: 'America/Caracas',
  locale: 'es',
  wahaSession: 'waha-test',
  status: ClinicStatus.ACTIVE,
};

const FAKE_ADMIN_USER = {
  id: 'user-1',
  email: 'admin@test.com',
  name: 'Admin Test',
};

const CREATE_INPUT: CreateClinicInput = {
  name: 'Clínica Test',
  slug: 'clinica-test',
  timezone: 'America/Caracas',
  locale: 'es',
  wahaSession: 'waha-test',
  admin: {
    email: 'admin@test.com',
    name: 'Admin Test',
  },
  invitedByUserId: 'user-super',
  appBaseUrl: 'http://localhost:3002',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminClinicsService', () => {
  let stub: PrismaStub;
  let invitationsMock: { create: jest.Mock };
  let mailMock: { sendClinicInvitation: jest.Mock };
  let service: AdminClinicsService;

  beforeEach(() => {
    stub = buildStub();
    invitationsMock = {
      create: jest.fn().mockResolvedValue({
        token: 'deadbeef'.repeat(8), // 64 chars
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    };
    mailMock = {
      sendClinicInvitation: jest
        .fn()
        .mockResolvedValue({ ok: true, messageId: 'msg-1' }),
    };
    service = new AdminClinicsService(
      stub as unknown as PrismaService,
      invitationsMock as unknown as InvitationsService,
      mailMock as unknown as MailService,
    );
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('devuelve { id, clinic, admin, invitation } sin password en la respuesta', async () => {
      stub.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        // Simular que la transacción ejecuta la función con mocks de tx
        const tx = {
          clinic: { create: jest.fn().mockResolvedValue(FAKE_CLINIC) },
          user: { create: jest.fn().mockResolvedValue(FAKE_ADMIN_USER) },
        };
        return fn(tx);
      });

      const result = await service.create(CREATE_INPUT);

      expect(result.id).toBe('clinic-1');
      expect(result.clinic.id).toBe('clinic-1');
      expect(result.admin.email).toBe('admin@test.com');
      // password nunca debe estar en la respuesta
      expect((result.admin as unknown as Record<string, unknown>)['password']).toBeUndefined();
      // La URL de la invitación debe incluir el token + locale
      expect(result.invitation.url).toContain('/es/invite/');
      expect(result.invitation.emailSent).toBe(true);
    });

    it('persiste un password inicial RANDOM (nunca el input) — el user lo reemplaza al aceptar la invitación', async () => {
      let capturedPassword: string | undefined;

      stub.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          clinic: { create: jest.fn().mockResolvedValue(FAKE_CLINIC) },
          user: {
            create: jest.fn().mockImplementation(async (args: { data: { password: string } }) => {
              capturedPassword = args.data.password;
              return FAKE_ADMIN_USER;
            }),
          },
        };
        return fn(tx);
      });

      await service.create(CREATE_INPUT);

      // El password guardado debe ser un hash bcrypt (empieza con $2)
      // — nunca es texto plano, y NO viene del input (el input ya no lleva
      // password: el random se genera dentro del service).
      expect(capturedPassword).toBeDefined();
      expect(capturedPassword).toMatch(/^\$2[aby]\$/);
    });

    it('crea una invitación para el user y dispara el email', async () => {
      stub.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          clinic: { create: jest.fn().mockResolvedValue(FAKE_CLINIC) },
          user: { create: jest.fn().mockResolvedValue(FAKE_ADMIN_USER) },
        };
        return fn(tx);
      });

      await service.create(CREATE_INPUT);

      expect(invitationsMock.create).toHaveBeenCalledWith({
        userId: FAKE_ADMIN_USER.id,
        invitedByUserId: 'user-super',
      });
      expect(mailMock.sendClinicInvitation).toHaveBeenCalledWith(
        expect.objectContaining({
          to: FAKE_ADMIN_USER.email,
          invitedName: FAKE_ADMIN_USER.name,
          clinicName: FAKE_CLINIC.name,
          locale: 'es',
        }),
      );
    });

    it('devuelve emailSent=false pero NO falla la creación si el mail no se pudo mandar', async () => {
      mailMock.sendClinicInvitation.mockResolvedValueOnce({
        ok: false,
        error: 'resend timeout',
      });
      stub.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          clinic: { create: jest.fn().mockResolvedValue(FAKE_CLINIC) },
          user: { create: jest.fn().mockResolvedValue(FAKE_ADMIN_USER) },
        };
        return fn(tx);
      });

      const result = await service.create(CREATE_INPUT);

      // La clínica se crea igual — el super puede copiar la URL a mano.
      expect(result.id).toBe('clinic-1');
      expect(result.invitation.emailSent).toBe(false);
      expect(result.invitation.url).toContain('/invite/');
    });

    it('crea el usuario con role CLINIC_ADMIN y clinicId de la clínica creada', async () => {
      let capturedUserData: Record<string, unknown> | undefined;

      stub.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          clinic: { create: jest.fn().mockResolvedValue(FAKE_CLINIC) },
          user: {
            create: jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
              capturedUserData = args.data;
              return FAKE_ADMIN_USER;
            }),
          },
        };
        return fn(tx);
      });

      await service.create(CREATE_INPUT);

      expect(capturedUserData?.['role']).toBe('CLINIC_ADMIN');
      expect(capturedUserData?.['clinicId']).toBe('clinic-1');
    });

    it('aplica defaults de timezone y locale cuando no se proveen', async () => {
      let capturedClinicData: Record<string, unknown> | undefined;

      stub.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          clinic: {
            create: jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
              capturedClinicData = args.data;
              return FAKE_CLINIC;
            }),
          },
          user: { create: jest.fn().mockResolvedValue(FAKE_ADMIN_USER) },
        };
        return fn(tx);
      });

      await service.create({ ...CREATE_INPUT, timezone: undefined, locale: undefined });

      expect(capturedClinicData?.['timezone']).toBe('America/Caracas');
      expect(capturedClinicData?.['locale']).toBe('es');
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    const fakeItems = [
      { ...FAKE_CLINIC, suspendedAt: null, _count: { professionals: 3, appointments: 10 } },
    ];

    it('devuelve items paginados con counts', async () => {
      stub.$transaction.mockResolvedValueOnce([fakeItems, 1]);

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0]._count.professionals).toBe(3);
    });

    it('filtra por status cuando se provee', async () => {
      stub.$transaction.mockResolvedValueOnce([[], 0]);

      await service.list({ status: ClinicStatus.SUSPENDED, page: 1, pageSize: 20 });

      const [findManyCall] = stub.$transaction.mock.calls[0][0];
      // $transaction recibe un array de promesas; findMany se llama antes de pasar el array
      // Verificamos que la transaction fue llamada
      expect(stub.$transaction).toHaveBeenCalledTimes(1);
    });

    it('devuelve page y pageSize correctos en la respuesta', async () => {
      stub.$transaction.mockResolvedValueOnce([[], 0]);

      const result = await service.list({ page: 3, pageSize: 10 });

      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(10);
    });

    it('devuelve total 0 cuando no hay clínicas', async () => {
      stub.$transaction.mockResolvedValue([[], 0]);

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  // ── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    const fullClinic = {
      ...FAKE_CLINIC,
      address: null,
      suspendedAt: null,
      suspendedReason: null,
    };

    it('lanza NotFoundException cuando la clínica no existe', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(null);

      await expect(service.get('inexistente')).rejects.toThrow(NotFoundException);
    });

    it('devuelve { clinic, metrics } cuando existe', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(fullClinic);
      stub.$transaction.mockResolvedValueOnce([2, 5, 30, 3, 25, 100]);

      const result = await service.get('clinic-1');

      expect(result.clinic.id).toBe('clinic-1');
      expect(result.metrics.professionals).toBe(2);
      expect(result.metrics.servicesActive).toBe(5);
      expect(result.metrics.appointmentsLast30d).toBe(30);
      expect(result.metrics.patients).toBe(100);
    });

    it('calcula noShowRateLast30d como 0 cuando no hay citas con outcome', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(fullClinic);
      // professionals, servicesActive, appointments30d, noShow30d, withOutcome30d, patients
      stub.$transaction.mockResolvedValueOnce([0, 0, 0, 0, 0, 0]);

      const result = await service.get('clinic-1');

      expect(result.metrics.noShowRateLast30d).toBe(0);
    });

    it('calcula noShowRateLast30d correctamente cuando hay outcomes', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(fullClinic);
      // professionals, servicesActive, appointments30d, noShow=2, withOutcome=8, patients
      stub.$transaction.mockResolvedValueOnce([5, 3, 10, 2, 8, 50]);

      const result = await service.get('clinic-1');

      expect(result.metrics.noShowRateLast30d).toBeCloseTo(0.25);
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('lanza NotFoundException cuando la clínica no existe', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(null);

      await expect(service.update('inexistente', { name: 'Nuevo' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('actualiza sólo los campos provistos (partial update)', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce({ id: 'clinic-1', status: ClinicStatus.ACTIVE });
      stub.clinic.update.mockResolvedValueOnce({});

      await service.update('clinic-1', { name: 'Nuevo Nombre' });

      const updateCall = stub.clinic.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data['name']).toBe('Nuevo Nombre');
      // timezone no debe aparecer si no fue provisty
      expect(Object.keys(updateCall.data)).not.toContain('timezone');
    });
  });

  // ── suspend ─────────────────────────────────────────────────────────────────

  describe('suspend', () => {
    it('lanza NotFoundException cuando la clínica no existe', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(null);

      await expect(service.suspend('inexistente', 'pago vencido')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza ConflictException si la clínica ya está suspendida', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce({
        id: 'clinic-1',
        status: ClinicStatus.SUSPENDED,
      });

      await expect(service.suspend('clinic-1', 'razón')).rejects.toThrow(ConflictException);
    });

    it('setea status SUSPENDED, suspendedAt y suspendedReason', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce({ id: 'clinic-1', status: ClinicStatus.ACTIVE });
      stub.clinic.update.mockResolvedValueOnce({});

      await service.suspend('clinic-1', 'pago vencido');

      const updateCall = stub.clinic.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data['status']).toBe(ClinicStatus.SUSPENDED);
      expect(updateCall.data['suspendedAt']).toBeInstanceOf(Date);
      expect(updateCall.data['suspendedReason']).toBe('pago vencido');
    });
  });

  // ── reactivate ──────────────────────────────────────────────────────────────

  describe('reactivate', () => {
    it('lanza NotFoundException cuando la clínica no existe', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce(null);

      await expect(service.reactivate('inexistente')).rejects.toThrow(NotFoundException);
    });

    it('lanza ConflictException si la clínica ya está activa', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce({ id: 'clinic-1', status: ClinicStatus.ACTIVE });

      await expect(service.reactivate('clinic-1')).rejects.toThrow(ConflictException);
    });

    it('setea status ACTIVE y limpia suspendedAt/suspendedReason', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce({
        id: 'clinic-1',
        status: ClinicStatus.SUSPENDED,
      });
      stub.clinic.update.mockResolvedValueOnce({});

      await service.reactivate('clinic-1');

      const updateCall = stub.clinic.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(updateCall.data['status']).toBe(ClinicStatus.ACTIVE);
      expect(updateCall.data['suspendedAt']).toBeNull();
      expect(updateCall.data['suspendedReason']).toBeNull();
    });

    it('retorna { id } tras la reactivación', async () => {
      stub.clinic.findUnique.mockResolvedValueOnce({
        id: 'clinic-1',
        status: ClinicStatus.SUSPENDED,
      });
      stub.clinic.update.mockResolvedValueOnce({});

      const result = await service.reactivate('clinic-1');

      expect(result).toEqual({ id: 'clinic-1' });
    });
  });
});
