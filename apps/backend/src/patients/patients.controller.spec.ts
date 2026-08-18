import { NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { PatientsController } from './patients.controller';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

/**
 * PatientsController tests:
 * - Multi-tenant (leak entre clínicas).
 * - Búsqueda `q` matchea case-insensitive en name + phone.
 * - Detail incluye contadores (_count).
 * - Historial: appointments desc + conversation con lastMessage.
 * - PATCH: name se actualiza; consent es ratchet (false→true OK, true→false ignorado).
 */
describe('PatientsController', () => {
  let prisma: Deep<PrismaService>;
  let controller: PatientsController;

  const adminA: AuthUser = {
    userId: 'user-A',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  beforeEach(() => {
    prisma = {
      patient: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pat-1',
          phone: '+584141234567',
          name: 'Ana',
          consent: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          _count: { appointments: 3, conversations: 1 },
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'pat-1',
            phone: '+584141234567',
            name: 'Ana',
            consent: true,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            _count: { appointments: 3 },
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'pat-1',
            phone: '+584141234567',
            name: 'Ana',
            consent: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            _count: { appointments: 3, conversations: 1 },
            ...data,
          }),
        ),
      },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    controller = new PatientsController(
      prisma as unknown as PrismaService,
      {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        trace: jest.fn(),
        fatal: jest.fn(),
        setContext: jest.fn(),
      } as unknown as import('nestjs-pino').PinoLogger,
    );
  });

  /* ─────────────────────── list ─────────────────────── */

  describe('list', () => {
    it('sin q → devuelve todos scoped al tenant', async () => {
      const result = await controller.list(adminA, {});
      expect(result.total).toBe(1);
      expect(result.rows[0].appointmentCount).toBe(3);
      const call = prisma.patient.findMany.mock.calls[0][0];
      expect(call.where.clinicId).toBe('clinic-A');
      // Sin filtro de search cuando q está vacío.
      expect(call.where.OR).toBeUndefined();
    });

    it('con q → filtra por name/phone case-insensitive', async () => {
      await controller.list(adminA, { q: 'ana' });
      const call = prisma.patient.findMany.mock.calls[0][0];
      expect(call.where.OR).toEqual([
        { name: { contains: 'ana', mode: 'insensitive' } },
        { phone: { contains: 'ana', mode: 'insensitive' } },
      ]);
    });

    it('trim de q — "  ana  " → "ana"', async () => {
      await controller.list(adminA, { q: '  ana  ' });
      const call = prisma.patient.findMany.mock.calls[0][0];
      expect(call.where.OR[0].name.contains).toBe('ana');
    });

    it('respeta limit + offset', async () => {
      await controller.list(adminA, { limit: 10, offset: 20 });
      const call = prisma.patient.findMany.mock.calls[0][0];
      expect(call.take).toBe(10);
      expect(call.skip).toBe(20);
    });

    it('response.rows aplana _count.appointments → appointmentCount', async () => {
      const result = await controller.list(adminA, {});
      expect(result.rows[0]).not.toHaveProperty('_count');
      expect(result.rows[0].appointmentCount).toBe(3);
    });
  });

  /* ─────────────────────── findOne ─────────────────────── */

  describe('findOne', () => {
    it('happy path — aplana _count', async () => {
      const result = await controller.findOne(adminA, 'pat-1');
      expect(result.appointmentCount).toBe(3);
      expect(result.conversationCount).toBe(1);
      expect(result).not.toHaveProperty('_count');
    });

    it('cross-tenant → 404 (findFirst con tenantWhere devuelve null)', async () => {
      prisma.patient.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.findOne(adminA, 'pat-de-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /* ─────────────────────── history ─────────────────────── */

  describe('history', () => {
    it('404 si el paciente no está en el scope', async () => {
      prisma.patient.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.history(adminA, 'pat-de-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Sin patient → no ejecutamos las queries del historial (short-circuit).
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    });

    it('devuelve appointments desc por startAt + conversation con lastMessage', async () => {
      prisma.appointment.findMany.mockResolvedValueOnce([
        {
          id: 'appt-1',
          startAt: new Date('2026-06-01T10:00:00Z'),
          endAt: new Date('2026-06-01T10:30:00Z'),
          status: 'CONFIRMADA',
          service: { id: 'svc-1', name: 'Consulta', durationMin: 30 },
          professional: { id: 'prof-1', name: 'Dra. Ríos' },
        },
      ]);
      prisma.conversation.findFirst.mockResolvedValueOnce({
        id: 'convo-1',
        state: 'BOT',
        updatedAt: new Date('2026-06-02T00:00:00Z'),
        contactName: 'Ana',
        messages: [
          {
            body: 'Gracias',
            direction: 'IN',
            createdAt: new Date('2026-06-02T00:00:00Z'),
          },
        ],
      });

      const result = await controller.history(adminA, 'pat-1');
      expect(result.appointments).toHaveLength(1);
      expect(result.appointments[0].service.name).toBe('Consulta');
      expect(result.conversation?.lastMessage?.body).toBe('Gracias');
      // El order es load-bearing (más reciente primero para el timeline).
      const call = prisma.appointment.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual({ startAt: 'desc' });
    });

    it('conversation null cuando no hay ninguna ligada al paciente', async () => {
      prisma.conversation.findFirst.mockResolvedValueOnce(null);
      const result = await controller.history(adminA, 'pat-1');
      expect(result.conversation).toBeNull();
    });
  });

  /* ─────────────────────── update ─────────────────────── */

  describe('update', () => {
    it('actualiza name', async () => {
      await controller.update(adminA, 'pat-1', { name: 'Ana Pérez' });
      const call = prisma.patient.update.mock.calls[0][0];
      expect(call.data.name).toBe('Ana Pérez');
    });

    it('consent ratchet: false→true prende', async () => {
      prisma.patient.findFirst.mockResolvedValueOnce({
        id: 'pat-1',
        consent: false,
      });
      await controller.update(adminA, 'pat-1', { consent: true });
      const call = prisma.patient.update.mock.calls[0][0];
      expect(call.data.consent).toBe(true);
    });

    it('consent ratchet: true→false se IGNORA (no aparece en data)', async () => {
      // Ya tenía consent=true. Mandar consent=false NO debería tocar el campo.
      prisma.patient.findFirst.mockResolvedValueOnce({
        id: 'pat-1',
        consent: true,
      });
      await controller.update(adminA, 'pat-1', { consent: false });
      // Si data quedó vacío, ni siquiera se llama a update — es un no-op.
      // Verificamos por el side path.
      if (prisma.patient.update.mock.calls.length > 0) {
        const call = prisma.patient.update.mock.calls[0][0];
        expect(call.data.consent).toBeUndefined();
      }
    });

    it('cross-tenant → 404', async () => {
      prisma.patient.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.update(adminA, 'pat-de-B', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('body vacío → no-op (no llama update, devuelve findOne)', async () => {
      prisma.patient.findFirst.mockResolvedValueOnce({
        id: 'pat-1',
        consent: false,
      });
      await controller.update(adminA, 'pat-1', {});
      expect(prisma.patient.update).not.toHaveBeenCalled();
    });
  });
});
