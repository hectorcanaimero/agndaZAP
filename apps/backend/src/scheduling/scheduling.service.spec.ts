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
        // Por defecto el paciente NO existe → camino `create` y
        // `patientCreated: true`. Los tests que necesitan uno preexistente
        // sobreescriben `findUnique`.
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'pat-1' }),
        update: jest.fn().mockResolvedValue({ id: 'pat-1' }),
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
    const { appointment: appt } = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'BOT',
    });

    expect(prisma.patient.create).toHaveBeenCalledTimes(1);
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
    const { appointment: appt } = await service.createAppointment({
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
    expect(prisma.service.findFirst).toHaveBeenCalledWith({
      where: { id: 'svc-of-clinic-B', clinicId: 'clinic-A', active: true },
    });
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

    const { appointment: appt } = await service.createAppointment({
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
    // Paciente nuevo → INSERT con consent true.
    expect(prisma.patient.create.mock.calls[0][0].data.consent).toBe(true);
  });

  it('consent solo se prende: con paciente preexistente el update nunca lo apaga', async () => {
    prisma.patient.findUnique.mockResolvedValue({ id: 'pat-1' });

    await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana', consent: true },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });

    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(prisma.patient.update.mock.calls[0][0].data.consent).toBe(true);
  });

  it('consent=false con paciente preexistente no toca el campo (no pisa un true previo)', async () => {
    prisma.patient.findUnique.mockResolvedValue({ id: 'pat-1' });

    await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', consent: false },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });

    expect(prisma.patient.update.mock.calls[0][0].data).not.toHaveProperty(
      'consent',
    );
  });

  // ── patientCreated: lo consume el bot para decidir si liga la Conversation ──
  it('patientCreated=true solo cuando el Patient nació en esta llamada', async () => {
    const nuevo = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });
    expect(nuevo.patientCreated).toBe(true);

    prisma.patient.findUnique.mockResolvedValue({ id: 'pat-1' });
    const existente = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });
    expect(existente.patientCreated).toBe(false);
  });

  it('carrera: si otro request creó el paciente entre el findUnique y el insert, patientCreated=false', async () => {
    // Sin esto el dato mentiría bajo concurrencia y el bot ligaría una
    // conversación a un paciente que no creó — justo lo que hay que evitar.
    prisma.patient.findUnique.mockResolvedValue(null);
    prisma.patient.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );

    const res = await service.createAppointment({
      clinicId: 'clinic-A',
      patient: { phone: '+584141234567', name: 'Ana' },
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO,
      source: 'PUBLIC',
    });

    expect(res.patientCreated).toBe(false);
    expect(prisma.patient.update).toHaveBeenCalledTimes(1);
  });
});

describe('SchedulingService.rescheduleAppointment', () => {
  let prisma: Deep<PrismaService>;
  let availability: Deep<AvailabilityService>;
  let reminders: Deep<RemindersService>;
  let service: SchedulingService;

  const zone = 'America/Caracas';
  const currentStart = DateTime.now()
    .setZone(zone)
    .plus({ days: 1 })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const newStart = currentStart.plus({ hours: 4 });
  const newStartISO = newStart.toISO()!;

  beforeEach(() => {
    prisma = {
      appointment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'appt-1',
          clinicId: 'clinic-A',
          serviceId: 'svc-1',
          professionalId: 'prof-1',
          status: 'PENDIENTE',
          startAt: currentStart.toJSDate(),
          endAt: currentStart.plus({ minutes: 30 }).toJSDate(),
          service: makeService(),
          clinic: makeClinic(),
        }),
        update: jest.fn().mockImplementation(({ where, data }: any) =>
          Promise.resolve({ id: where.id, ...data, status: 'PENDIENTE' }),
        ),
      },
    };
    availability = {
      getSlots: jest.fn().mockResolvedValue([
        {
          startAt: newStart.toJSDate(),
          endAt: newStart.plus({ minutes: 30 }).toJSDate(),
        },
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

  it('happy path: mueve startAt/endAt y reprograma reminders', async () => {
    const updated = await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });

    expect(prisma.appointment.update).toHaveBeenCalledWith({
      where: { id: 'appt-1' },
      data: {
        startAt: newStart.toJSDate(),
        endAt: newStart.plus({ minutes: 30 }).toJSDate(),
      },
    });
    expect(reminders.scheduleForAppointment).toHaveBeenCalledWith('appt-1');
    expect(updated.startAt).toEqual(newStart.toJSDate());
  });

  it('excluye la propia cita del cálculo de disponibilidad', async () => {
    // Load-bearing: sin excludeAppointmentId, la propia cita apareceria como
    // ocupada por si misma y bloquearia el mismo slot en el que ya esta.
    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });
    const call = availability.getSlots.mock.calls[0][0];
    expect(call.excludeAppointmentId).toBe('appt-1');
  });

  it('no-op cuando startAtISO coincide con el startAt actual (idempotencia)', async () => {
    const sameStartISO = currentStart.toISO()!;
    const result = await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: sameStartISO,
    });
    // Sin cambios: ni update ni reminders. Retorna el appt tal como está.
    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(reminders.scheduleForAppointment).not.toHaveBeenCalled();
    expect(result.startAt).toEqual(currentStart.toJSDate());
  });

  it('cita no encontrada (o cross-tenant) → NotFoundException', async () => {
    prisma.appointment.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-of-B',
        startAtISO: newStartISO,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza reagendar al pasado con BadRequestException', async () => {
    const pastISO = DateTime.now().setZone(zone).minus({ hours: 1 }).toISO()!;
    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: pastISO,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('slot no disponible → ConflictException', async () => {
    availability.getSlots.mockResolvedValueOnce([]); // ningun slot libre
    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: newStartISO,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('@@unique race → ConflictException', async () => {
    prisma.appointment.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: '5.0',
      }),
    );
    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: newStartISO,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('startAtISO inválido → BadRequestException', async () => {
    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: 'no-es-iso',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reminders falla → NO rollbackea el reschedule (fail-open, logueado)', async () => {
    reminders.scheduleForAppointment.mockRejectedValueOnce(
      new Error('queue down'),
    );
    const updated = await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });
    // Cita reagendada aunque reminders explote.
    expect(updated.startAt).toEqual(newStart.toJSDate());
    expect(prisma.appointment.update).toHaveBeenCalled();
  });
});

/**
 * Cancelación por el paciente desde el link de gestión (ADR 0020).
 *
 * Sin usuario autenticado: la autorización la da el token y por eso el estado
 * se re-valida contra la DB en cada llamada.
 */
describe('SchedulingService.cancelByPatient', () => {
  let prisma: any;
  let availability: any;
  let reminders: any;
  let service: SchedulingService;

  const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
  const past = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  function makeAppt(over: Record<string, unknown> = {}) {
    return {
      id: 'appt-1',
      clinicId: 'clinic-A',
      status: 'CONFIRMADA',
      startAt: future(),
      ...over,
    };
  }

  beforeEach(() => {
    prisma = {
      appointment: {
        findFirst: jest.fn().mockResolvedValue(makeAppt()),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ ...makeAppt(), ...data }),
        ),
      },
    };
    availability = { getSlots: jest.fn() };
    reminders = { cancelForAppointment: jest.fn().mockResolvedValue(undefined) };
    service = new SchedulingService(
      prisma as unknown as PrismaService,
      availability as unknown as AvailabilityService,
      reminders as unknown as RemindersService,
    );
  });

  it('cancela, sella canceledAt y apaga los recordatorios', async () => {
    const res = await service.cancelByPatient({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
    });

    expect(res.status).toBe('CANCELADA');
    expect(prisma.appointment.update.mock.calls[0][0].data.canceledAt).toBeInstanceOf(Date);
    // Un recordatorio de una cita cancelada solo puede hacer daño.
    expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-1');
  });

  it('multi-tenant: la cita se busca SIEMPRE acotada por clinicId', async () => {
    await service.cancelByPatient({ clinicId: 'clinic-A', appointmentId: 'appt-1' });

    expect(prisma.appointment.findFirst).toHaveBeenCalledWith({
      where: { id: 'appt-1', clinicId: 'clinic-A' },
    });
  });

  it('cita de otra clínica → 404, nunca se cancela', async () => {
    prisma.appointment.findFirst.mockResolvedValue(null);

    await expect(
      service.cancelByPatient({ clinicId: 'clinic-B', appointmentId: 'appt-1' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('es idempotente: cancelar dos veces no re-escribe ni re-cancela recordatorios', async () => {
    prisma.appointment.findFirst.mockResolvedValue(makeAppt({ status: 'CANCELADA' }));

    const res = await service.cancelByPatient({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
    });

    expect(res.status).toBe('CANCELADA');
    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
  });

  it.each(['ATENDIDA', 'NO_SHOW'])(
    'estado terminal %s → 409: cambiarlo falsearía el histórico',
    async (status) => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppt({ status }));

      await expect(
        service.cancelByPatient({ clinicId: 'clinic-A', appointmentId: 'appt-1' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    },
  );

  it('cita ya pasada → 409 aunque el estado siga PENDIENTE', async () => {
    prisma.appointment.findFirst.mockResolvedValue(
      makeAppt({ status: 'PENDIENTE', startAt: past() }),
    );

    await expect(
      service.cancelByPatient({ clinicId: 'clinic-A', appointmentId: 'appt-1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('si falla apagar los recordatorios, la cancelación NO se revierte', async () => {
    // Fail-open deliberado: lo que el paciente pidió ya está hecho; un
    // recordatorio huérfano se detecta por el log.
    reminders.cancelForAppointment.mockRejectedValue(new Error('redis down'));

    const res = await service.cancelByPatient({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
    });

    expect(res.status).toBe('CANCELADA');
  });
});

describe('SchedulingService.isPatientMutable', () => {
  const future = new Date(Date.now() + 3600_000);
  const past = new Date(Date.now() - 3600_000);

  it.each(['PENDIENTE', 'CONFIRMADA', 'EN_RIESGO'])(
    '%s en el futuro → gestionable',
    (status) => {
      expect(
        SchedulingService.isPatientMutable({ status, startAt: future } as any),
      ).toBe(true);
    },
  );

  it.each(['ATENDIDA', 'CANCELADA', 'NO_SHOW'])(
    '%s → no gestionable',
    (status) => {
      expect(
        SchedulingService.isPatientMutable({ status, startAt: future } as any),
      ).toBe(false);
    },
  );

  it('el pasado no se gestiona, sea cual sea el estado', () => {
    expect(
      SchedulingService.isPatientMutable({
        status: 'CONFIRMADA',
        startAt: past,
      } as any),
    ).toBe(false);
  });
});
