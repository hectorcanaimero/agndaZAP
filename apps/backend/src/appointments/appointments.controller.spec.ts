import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { AppointmentsController } from './appointments.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

/**
 * AppointmentsController tests:
 *  - list respeta multi-tenant + filtros.
 *  - PATCH status: FSM legal + side effects reminders.
 *  - PATCH status: FSM ilegal → 422.
 *  - GET /mine: usa User.professionalId, filtra por prof.
 *  - findOne: 404 cross-tenant.
 */
describe('AppointmentsController', () => {
  let prisma: Deep<PrismaService>;
  let reminders: Deep<RemindersService>;
  let scheduling: Deep<SchedulingService>;
  let controller: AppointmentsController;

  const adminA: AuthUser = {
    userId: 'user-A',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };
  const profUser: AuthUser = {
    userId: 'user-p',
    clinicId: 'clinic-A',
    role: 'PROFESSIONAL',
  };

  beforeEach(() => {
    prisma = {
      appointment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'appt-1',
          clinicId: 'clinic-A',
          status: 'PENDIENTE',
          professionalId: 'prof-1',
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'appt-1', ...data }),
        ),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          professionalId: 'prof-1',
          clinicId: 'clinic-A',
        }),
      },
      professional: {
        // Default: el professionalId filtrado siempre pertenece al tenant.
        // Los tests cross-tenant sobreescriben con `mockResolvedValueOnce(null)`.
        findFirst: jest.fn().mockResolvedValue({ id: 'prof-1' }),
      },
    };
    reminders = {
      confirmAppointment: jest.fn().mockResolvedValue(undefined),
      cancelForAppointment: jest.fn().mockResolvedValue(undefined),
    };
    scheduling = {
      createAppointment: jest.fn().mockResolvedValue({
        id: 'appt-new',
        status: 'PENDIENTE',
      }),
    };
    controller = new AppointmentsController(
      prisma as unknown as PrismaService,
      reminders as unknown as RemindersService,
      scheduling as unknown as SchedulingService,
    );
  });

  describe('list', () => {
    it('filtra por clinicId del user (multi-tenant)', async () => {
      await controller.list(adminA, {});
      const call = prisma.appointment.findMany.mock.calls[0][0];
      expect(call.where.clinicId).toBe('clinic-A');
    });

    it('aplica filtros status/professionalId/from/to', async () => {
      await controller.list(adminA, {
        status: 'PENDIENTE',
        professionalId: 'prof-1',
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-31T23:59:59Z',
      });
      const call = prisma.appointment.findMany.mock.calls[0][0];
      expect(call.where.status).toBe('PENDIENTE');
      expect(call.where.professionalId).toBe('prof-1');
      expect(call.where.startAt.gte).toBeInstanceOf(Date);
      expect(call.where.startAt.lte).toBeInstanceOf(Date);
    });

    it('response NO expone notes de las citas (menos PII en lista)', async () => {
      await controller.list(adminA, {});
      const call = prisma.appointment.findMany.mock.calls[0][0];
      expect(call.select.notes).toBeUndefined();
    });

    it('professionalId cross-tenant → 400 (audit M6)', async () => {
      prisma.professional.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.list(adminA, { professionalId: 'prof-of-B' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listMine (PROFESSIONAL)', () => {
    it('filtra por professionalId del user + clinicId', async () => {
      await controller.listMine(profUser, {});
      const call = prisma.appointment.findMany.mock.calls[0][0];
      expect(call.where.clinicId).toBe('clinic-A');
      expect(call.where.professionalId).toBe('prof-1');
    });

    it('404 si el user PROFESSIONAL no tiene professionalId en DB', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ professionalId: null });
      await expect(controller.listMine(profUser, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findOne', () => {
    it('404 si la cita no pertenece al tenant', async () => {
      prisma.appointment.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.findOne(adminA, 'appt-of-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('PROFESSIONAL sólo puede ver sus propias citas', async () => {
      prisma.appointment.findFirst.mockResolvedValueOnce({
        id: 'appt-1',
        professionalId: 'prof-1',
      });
      await controller.findOne(profUser, 'appt-1');
      const call = prisma.appointment.findFirst.mock.calls[0][0];
      expect(call.where.professionalId).toBe('prof-1');
    });
  });

  describe('patchStatus (FSM)', () => {
    it('PENDIENTE → CONFIRMADA: llama a reminders.confirmAppointment', async () => {
      await controller.patchStatus(adminA, 'appt-1', { status: 'CONFIRMADA' });
      expect(reminders.confirmAppointment).toHaveBeenCalledWith('appt-1');
      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
    });

    it('PENDIENTE → CANCELADA: 200 con status CANCELADA + cancelForAppointment (audit Nit-T1)', async () => {
      // Setup: cita en PENDIENTE (mock por default ya la deja en PENDIENTE).
      const result = await controller.patchStatus(adminA, 'appt-1', {
        status: 'CANCELADA',
      });
      // Response con status actualizado (mock update devuelve `{ id, ...data }`).
      expect(result.status).toBe('CANCELADA');
      // Side effect: reminders.cancelForAppointment fue llamado.
      expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-1');
      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
    });

    it('CONFIRMADA → CANCELADA: llama a reminders.cancelForAppointment', async () => {
      prisma.appointment.findFirst.mockResolvedValueOnce({
        id: 'appt-1',
        clinicId: 'clinic-A',
        status: 'CONFIRMADA',
      });
      await controller.patchStatus(adminA, 'appt-1', { status: 'CANCELADA' });
      expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-1');
    });

    it('CONFIRMADA → NO_SHOW: outcome=no_show + cancela reminders', async () => {
      prisma.appointment.findFirst.mockResolvedValueOnce({
        id: 'appt-1',
        clinicId: 'clinic-A',
        status: 'CONFIRMADA',
      });
      await controller.patchStatus(adminA, 'appt-1', { status: 'NO_SHOW' });
      const call = prisma.appointment.update.mock.calls[0][0];
      expect(call.data.outcome).toBe('no_show');
      expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-1');
    });

    it('CONFIRMADA → ATENDIDA: outcome=atendio, NO cancela reminders (ya sucedió)', async () => {
      prisma.appointment.findFirst.mockResolvedValueOnce({
        id: 'appt-1',
        clinicId: 'clinic-A',
        status: 'CONFIRMADA',
      });
      await controller.patchStatus(adminA, 'appt-1', { status: 'ATENDIDA' });
      const call = prisma.appointment.update.mock.calls[0][0];
      expect(call.data.outcome).toBe('atendio');
      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
    });

    it('PENDIENTE → ATENDIDA: transición ILEGAL → 422', async () => {
      await expect(
        controller.patchStatus(adminA, 'appt-1', { status: 'ATENDIDA' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
      expect(reminders.confirmAppointment).not.toHaveBeenCalled();
    });

    it('cross-tenant → 404', async () => {
      prisma.appointment.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.patchStatus(adminA, 'appt-of-B', { status: 'CONFIRMADA' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('side effect que falla: NO rompe el response del status change', async () => {
      reminders.confirmAppointment.mockRejectedValueOnce(new Error('redis down'));
      const result = await controller.patchStatus(adminA, 'appt-1', {
        status: 'CONFIRMADA',
      });
      expect(result).toBeDefined();
      expect(prisma.appointment.update).toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('delega a SchedulingService con source=PUBLIC + clinicId del scope', async () => {
      await controller.create(adminA, {
        phone: '+584141234567',
        name: 'Ana',
        consent: true,
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: '2030-06-01T10:00:00-04:00',
      });
      const call = scheduling.createAppointment.mock.calls[0][0];
      expect(call.clinicId).toBe('clinic-A');
      expect(call.source).toBe('PUBLIC');
      expect(call.patient.phone).toBe('+584141234567');
    });

    it('normaliza phone sin `+` inicial', async () => {
      await controller.create(adminA, {
        phone: '584141234567',
        consent: true,
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: '2030-06-01T10:00:00-04:00',
      });
      const call = scheduling.createAppointment.mock.calls[0][0];
      expect(call.patient.phone).toBe('+584141234567');
    });

    it('SUPERADMIN con consent=false → 400 (rol interno NO otorga consent)', async () => {
      // Ver ADR 0006. Antes había un bypass `!isSuperadmin(user)` — no más.
      const superadmin: AuthUser = {
        userId: 'u-super',
        clinicId: null,
        role: 'SUPERADMIN',
      };
      await expect(
        controller.create(
          superadmin,
          {
            phone: '+584141234567',
            consent: false as unknown as true, // simulamos bypass del ValidationPipe
            serviceId: 'svc-1',
            professionalId: 'prof-1',
            startAtISO: '2030-06-01T10:00:00-04:00',
          },
          'clinic-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduling.createAppointment).not.toHaveBeenCalled();
    });

    it('CLINIC_ADMIN con consent=true → 201 (happy path)', async () => {
      const result = await controller.create(adminA, {
        phone: '+584141234567',
        consent: true,
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: '2030-06-01T10:00:00-04:00',
      });
      expect(result).toBeDefined();
      expect(scheduling.createAppointment).toHaveBeenCalledTimes(1);
    });
  });
});
