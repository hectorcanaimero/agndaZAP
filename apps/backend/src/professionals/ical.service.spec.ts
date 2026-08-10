import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IcalService } from './ical.service';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('IcalService', () => {
  let prisma: Deep<PrismaService>;
  let svc: IcalService;

  const originalSecret = process.env.ICAL_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.ICAL_SECRET = 'test-secret';
    prisma = {
      professional: { findUnique: jest.fn() },
      appointment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new IcalService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.ICAL_SECRET;
    else process.env.ICAL_SECRET = originalSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  /* ─────────────────────── tokenFor / verifyToken ─────────────────────── */

  describe('tokenFor / verifyToken', () => {
    it('mismo id + mismo secret → mismo token (determinístico)', () => {
      const a = svc.tokenFor('prof-1');
      const b = svc.tokenFor('prof-1');
      expect(a).toBe(b);
      expect(a).toHaveLength(32);
    });

    it('distintos ids → distintos tokens', () => {
      expect(svc.tokenFor('prof-1')).not.toBe(svc.tokenFor('prof-2'));
    });

    it('cambiar el secret cambia el token (rotación revoca)', () => {
      const a = svc.tokenFor('prof-1');
      process.env.ICAL_SECRET = 'other-secret';
      const b = svc.tokenFor('prof-1');
      expect(a).not.toBe(b);
    });

    it('verifyToken: happy path', () => {
      const t = svc.tokenFor('prof-1');
      expect(svc.verifyToken('prof-1', t)).toBe(true);
    });

    it('verifyToken: token para otro id → false', () => {
      const t = svc.tokenFor('prof-1');
      expect(svc.verifyToken('prof-2', t)).toBe(false);
    });

    it('verifyToken: token undefined → false (no crashea)', () => {
      expect(svc.verifyToken('prof-1', undefined)).toBe(false);
    });

    it('verifyToken: token de longitud distinta → false (sin comparar bytes)', () => {
      // timingSafeEqual crashea si difieren en longitud — el guard interno evita esto.
      expect(svc.verifyToken('prof-1', 'short')).toBe(false);
    });

    it('secret ausente en producción → throw (fail-fast)', () => {
      delete process.env.ICAL_SECRET;
      process.env.NODE_ENV = 'production';
      expect(() => svc.tokenFor('prof-1')).toThrow(
        /ICAL_SECRET no configurado en producción/,
      );
    });
  });

  /* ─────────────────────── buildFeed ─────────────────────── */

  describe('buildFeed', () => {
    it('feed vacío cuando el profesional no existe (defensivo)', async () => {
      prisma.professional.findUnique.mockResolvedValue(null);
      const ics = await svc.buildFeed('missing');
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('END:VCALENDAR');
      expect(ics).not.toContain('BEGIN:VEVENT');
    });

    it('genera VEVENT por cada appointment activo', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        id: 'prof-1',
        name: 'Dra. Ríos',
        clinic: { name: 'Clínica A', timezone: 'America/Caracas' },
      });
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: 'appt-1',
          startAt: new Date('2030-06-01T14:00:00Z'),
          endAt: new Date('2030-06-01T14:30:00Z'),
          updatedAt: new Date('2030-05-30T10:00:00Z'),
          status: 'CONFIRMADA',
          notes: null,
          patient: { name: 'Ana', phone: '+584141234567' },
          service: { name: 'Consulta' },
        },
      ]);
      const ics = await svc.buildFeed('prof-1');
      expect(ics).toContain('BEGIN:VEVENT');
      expect(ics).toContain('UID:appt-appt-1@agendazap');
      expect(ics).toContain('DTSTART:20300601T140000Z');
      expect(ics).toContain('DTEND:20300601T143000Z');
      expect(ics).toContain('SUMMARY:Ana · Consulta');
      expect(ics).toContain('STATUS:CONFIRMED');
    });

    it('excluye CANCELADA y NO_SHOW del where', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        id: 'prof-1',
        name: 'Dra. Ríos',
        clinic: { name: 'Clínica A', timezone: 'America/Caracas' },
      });
      await svc.buildFeed('prof-1');
      const call = prisma.appointment.findMany.mock.calls[0][0];
      expect(call.where.status.notIn).toEqual(['CANCELADA', 'NO_SHOW']);
    });

    it('mapea PENDIENTE/EN_RIESGO → TENTATIVE, CONFIRMADA/ATENDIDA → CONFIRMED', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        id: 'prof-1',
        name: 'Dra. Ríos',
        clinic: { name: 'Clínica A', timezone: 'America/Caracas' },
      });
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: 'a',
          startAt: new Date('2030-06-01T14:00:00Z'),
          endAt: new Date('2030-06-01T14:30:00Z'),
          updatedAt: new Date(),
          status: 'PENDIENTE',
          notes: null,
          patient: { name: 'X', phone: '+1' },
          service: { name: 'S' },
        },
      ]);
      const ics = await svc.buildFeed('prof-1');
      expect(ics).toContain('STATUS:TENTATIVE');
    });

    it('escapa correctamente , ; \\ y newlines en SUMMARY/DESCRIPTION', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        id: 'prof-1',
        name: 'Dra. Ríos',
        clinic: { name: 'Clínica; A, con "chars"', timezone: 'UTC' },
      });
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: 'a',
          startAt: new Date('2030-06-01T14:00:00Z'),
          endAt: new Date('2030-06-01T14:30:00Z'),
          updatedAt: new Date(),
          status: 'CONFIRMADA',
          notes: 'Nota; con, comas',
          patient: { name: 'Juan, Carlos', phone: '+1' },
          service: { name: 'S' },
        },
      ]);
      const ics = await svc.buildFeed('prof-1');
      // Los `,` y `;` DEBEN ir escapados como \, y \;
      expect(ics).toContain('SUMMARY:Juan\\, Carlos · S');
      expect(ics).toMatch(/Notas: Nota\\; con\\, comas/);
    });

    it('tolera Patient.name null (schema permite)', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        id: 'prof-1',
        name: 'Dra. Ríos',
        clinic: { name: 'Clínica A', timezone: 'UTC' },
      });
      prisma.appointment.findMany.mockResolvedValue([
        {
          id: 'a',
          startAt: new Date('2030-06-01T14:00:00Z'),
          endAt: new Date('2030-06-01T14:30:00Z'),
          updatedAt: new Date(),
          status: 'CONFIRMADA',
          notes: null,
          patient: { name: null, phone: '+1' },
          service: { name: 'S' },
        },
      ]);
      const ics = await svc.buildFeed('prof-1');
      expect(ics).toContain('SUMMARY:Paciente · S');
      expect(ics).toContain('Paciente: (sin nombre)');
    });

    it('usa CRLF entre líneas (RFC 5545)', async () => {
      prisma.professional.findUnique.mockResolvedValue({
        id: 'prof-1',
        name: 'Dra. Ríos',
        clinic: { name: 'Clínica A', timezone: 'UTC' },
      });
      const ics = await svc.buildFeed('prof-1');
      expect(ics).toContain('\r\n');
    });
  });
});
