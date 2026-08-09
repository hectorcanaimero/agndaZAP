import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { RemindersService } from '../reminders/reminders.service';
import { AvailabilityService } from './availability.service';
import { SchedulingService } from './scheduling.service';

/**
 * Tests focales de la lógica de negocio de creación de cita.
 * Cubren dos escenarios Gherkin del SPEC + un test multi-tenant.
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

function makeClinic(overrides: Partial<any> = {}) {
  return {
    id: 'clinic-A',
    name: 'Clínica A',
    slug: 'clinica-a',
    timezone: 'America/Caracas',
    locale: 'es',
    wahaSession: 'clinic-a-session',
    wahaConnected: true,
    address: 'Av. Siempre Viva 123',
    reminderOffsetsH: [24, 3],
    confirmThresholdH: 6,
    autoConfirm: false,
    ...overrides,
  };
}

function makeService(overrides: Partial<any> = {}) {
  return {
    id: 'svc-1',
    clinicId: 'clinic-A',
    name: 'Consulta general',
    durationMin: 30,
    bufferMin: 0,
    active: true,
    ...overrides,
  };
}

function makeProfessional(overrides: Partial<any> = {}) {
  return {
    id: 'prof-1',
    clinicId: 'clinic-A',
    name: 'Dra. Ríos',
    active: true,
    services: [{ id: 'svc-1' }],
    ...overrides,
  };
}

describe('SchedulingService.createAppointment', () => {
  let prisma: Deep<PrismaService>;
  let availability: Deep<AvailabilityService>;
  let reminders: Deep<RemindersService>;
  let service: SchedulingService;

  const zone = 'America/Caracas';
  // Mañana 10:00 en la TZ de la clínica.
  const tomorrow10 = DateTime.now()
    .setZone(zone)
    .plus({ days: 1 })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const startAtISO = tomorrow10.toISO()!;

  beforeEach(() => {
    prisma = {
      clinic: { findUnique: jest.fn().mockResolvedValue(makeClinic()) },
      service: { findFirst: jest.fn().mockResolvedValue(makeService()) },
      professional: {
        findFirst: jest.fn().mockResolvedValue(makeProfessional()),
      },
      patient: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: 'pat-1',
          clinicId: 'clinic-A',
          phone: '+584141234567',
          name: 'Ana',
          consent: false,
        }),
      },
      appointment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'appt-1',
            ...data,
          }),
        ),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    };
    availability = {
      getSlots: jest.fn().mockResolvedValue([
        { startAt: tomorrow10.toJSDate(), endAt: tomorrow10.plus({ minutes: 30 }).toJSDate() },
      ]),
    };
    reminders = {
      scheduleForAppointment: jest.fn().mockResolvedValue(undefined),
    };

    service = new SchedulingService(
      prisma as unknown as PrismaService,
      availability as unknown as AvailabilityService,
      reminders as unknown as RemindersService,
    );
  });

  // Scenario Gherkin: Paciente agenda en un horario disponible
  it('crea la cita y programa recordatorios cuando el slot está libre', async () => {
    const appt = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'BOT',
    });

    expect(prisma.patient.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.appointment.create).toHaveBeenCalledTimes(1);
    expect(reminders.scheduleForAppointment).toHaveBeenCalledWith('appt-1');
    // Estado PENDIENTE porque autoConfirm=false
    expect(appt.status).toBe('PENDIENTE');
    // endAt = startAt + durationMin (30 min)
    expect((appt.endAt as Date).getTime() - (appt.startAt as Date).getTime()).toBe(30 * 60 * 1000);
  });

  it('crea la cita CONFIRMADA cuando clinic.autoConfirm=true', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce(
      makeClinic({ autoConfirm: true }),
    );
    const appt = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });
    expect(appt.status).toBe('CONFIRMADA');
    expect(appt.confirmedAt).toBeInstanceOf(Date);
  });

  // Scenario Gherkin: No se permite doble reserva del mismo slot
  it('tira ConflictException 409 si el @@unique falla (doble reserva)', async () => {
    prisma.appointment.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique failed', {
        code: 'P2002',
        clientVersion: '5.20.0',
      }),
    );

    await expect(
      service.createAppointment({
        clinicId: 'clinic-A',
        patient: { phone: '+584141234567' },
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO,
        source: 'PUBLIC',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(reminders.scheduleForAppointment).not.toHaveBeenCalled();
  });

  it('tira ConflictException si availability ya no ofrece ese slot', async () => {
    availability.getSlots.mockResolvedValueOnce([]); // slot ocupado por otro

    await expect(
      service.createAppointment({
        clinicId: 'clinic-A',
        patient: { phone: '+584141234567' },
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO,
        source: 'PUBLIC',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  // Multi-tenant: intento de fuga entre clínicas
  it('rechaza el intento de usar un serviceId de otra clínica', async () => {
    // service.findFirst filtra por clinicId → no encuentra nada.
    prisma.service.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.createAppointment({
        clinicId: 'clinic-A',
        patient: { phone: '+584141234567' },
        serviceId: 'svc-of-clinic-B',
        professionalId: 'prof-1',
        startAtISO,
        source: 'PUBLIC',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
    expect(reminders.scheduleForAppointment).not.toHaveBeenCalled();
  });

  it('rechaza fecha en el pasado con BadRequestException', async () => {
    const past = DateTime.now().setZone(zone).minus({ days: 1 }).toISO()!;
    await expect(
      service.createAppointment({
        clinicId: 'clinic-A',
        patient: { phone: '+584141234567' },
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: past,
        source: 'PUBLIC',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // Idempotencia del bot
  it('devuelve la cita existente sin crear una nueva si source=BOT y hay una futura activa', async () => {
    prisma.patient.findUnique.mockResolvedValueOnce({
      id: 'pat-1',
      clinicId: 'clinic-A',
      phone: '+584141234567',
    });
    prisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'appt-existing',
      status: 'PENDIENTE',
      startAt: tomorrow10.toJSDate(),
      endAt: tomorrow10.plus({ minutes: 30 }).toJSDate(),
    });

    const appt = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'BOT',
    });

    expect(appt.id).toBe('appt-existing');
    expect(prisma.appointment.create).not.toHaveBeenCalled();
    expect(reminders.scheduleForAppointment).not.toHaveBeenCalled();
  });

  it('marca consent=true cuando el paciente lo confirma en el input', async () => {
    await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana', consent: true },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });
    const upsertCall = prisma.patient.upsert.mock.calls[0][0];
    expect(upsertCall.create.consent).toBe(true);
    expect(upsertCall.update.consent).toBe(true);
  });
});
