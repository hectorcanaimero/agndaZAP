import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
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
      // Devuelve cuántos avisos quedaron armados: `rescheduleAppointment` lo
      // usa para decidir si puede degradar el estado a PENDIENTE.
      scheduleForAppointment: jest
        .fn()
        .mockResolvedValue({ remindersScheduled: 2, riskScheduled: true }),
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

  it('un error que NO es P2002 se propaga: no lo tapamos con un update', async () => {
    prisma.patient.findUnique.mockResolvedValue(null);
    prisma.patient.create.mockRejectedValue(new Error('conexión caída'));

    await expect(
      service.createAppointment({
        clinicId: 'clinic-A',
        patient: { phone: '+584141234567', name: 'Ana' },
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO,
        source: 'PUBLIC',
      }),
    ).rejects.toThrow('conexión caída');
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  it('un P2002 de OTRO unique también se propaga, no se confunde con el de phone', async () => {
    // El día que Patient gane un unique de email o documento, mandar ese
    // conflicto a un update por clinicId_phone moriría con P2025 y taparía el
    // error real.
    prisma.patient.findUnique.mockResolvedValue(null);
    prisma.patient.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['clinicId', 'email'] },
      }),
    );

    await expect(
      service.createAppointment({
        clinicId: 'clinic-A',
        patient: { phone: '+584141234567', name: 'Ana' },
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO,
        source: 'PUBLIC',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(prisma.patient.update).not.toHaveBeenCalled();
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
        // Como Prisma: devuelve la fila con los campos nuevos aplicados
        // encima de la base. Si el mock forzara un status, los tests del
        // reset de confirmación pasarían por construcción.
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const base = await prisma.appointment.findFirst();
          return { ...base, id: where.id, ...data };
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'appt-1',
          clinicId: 'clinic-A',
          status: 'PENDIENTE',
          startAt: newStart.toJSDate(),
          patientRescheduleCount: 1,
        }),
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
      // Devuelve cuántos avisos quedaron armados: `rescheduleAppointment` lo
      // usa para decidir si puede degradar el estado a PENDIENTE.
      scheduleForAppointment: jest
        .fn()
        .mockResolvedValue({ remindersScheduled: 2, riskScheduled: true }),
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

    const data = prisma.appointment.update.mock.calls[0][0].data;
    expect(data.startAt).toEqual(newStart.toJSDate());
    expect(data.endAt).toEqual(newStart.plus({ minutes: 30 }).toJSDate());
    // `scheduleForAppointment` reprograma recordatorios Y check-risk.
    expect(reminders.scheduleForAppointment).toHaveBeenCalledWith('appt-1');
    expect(updated.startAt).toEqual(newStart.toJSDate());
  });

  // ── S6: traza de reagendamientos y reinicio del ciclo de confirmación ──
  it('vuelve a PENDIENTE y limpia confirmedAt cuando queda vía de recuperación', async () => {
    // Caso real: cita CONFIRMADA por teléfono que se mueve a otro día. El
    // recordatorio del horario nuevo permite reconfirmar, así que degradar el
    // estado es correcto.
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      clinicId: 'clinic-A',
      status: 'CONFIRMADA',
      confirmedAt: new Date('2030-05-30T10:00:00.000Z'),
      startAt: new Date('2030-06-01T14:00:00.000Z'),
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      service: { durationMin: 30 },
      clinic: { timezone: 'America/Caracas' },
    });
    reminders.scheduleForAppointment.mockResolvedValue({
      remindersScheduled: 2,
      riskScheduled: true,
    });

    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });

    const reset = prisma.appointment.update.mock.calls.at(-1)[0].data;
    expect(reset.status).toBe('PENDIENTE');
    expect(reset.confirmedAt).toBeNull();
  });

  it('SIN vía de recuperación conserva el estado: no desconfirma en silencio', async () => {
    // Caso real y frecuente: recepción mueve una cita de HOY un par de horas.
    // Con offsets [24,3] no cabe ningún recordatorio ni el check-risk, así que
    // degradar a PENDIENTE dejaría la cita desconfirmada para siempre, el
    // dashboard perdería la confirmación y el iCal pasaría a TENTATIVE — todo
    // sin que nadie se entere, porque el panel dice "reagendado OK".
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      clinicId: 'clinic-A',
      status: 'CONFIRMADA',
      confirmedAt: new Date('2030-05-30T10:00:00.000Z'),
      startAt: new Date('2030-06-01T14:00:00.000Z'),
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      service: { durationMin: 30 },
      clinic: { timezone: 'America/Caracas' },
    });
    reminders.scheduleForAppointment.mockResolvedValue({
      remindersScheduled: 0,
      riskScheduled: false,
    });

    const updated = await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });

    // Solo el update del movimiento; ningún segundo update de estado.
    expect(prisma.appointment.update).toHaveBeenCalledTimes(1);
    expect(updated.status).toBe('CONFIRMADA');
  });

  it('si la reprogramación falla tampoco desconfirma', async () => {
    reminders.scheduleForAppointment.mockRejectedValue(new Error('redis down'));

    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });

    expect(prisma.appointment.update).toHaveBeenCalledTimes(1);
  });

  it('un 409 por slot ocupado NO incrementa el contador', async () => {
    availability.getSlots.mockResolvedValue([]);

    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: newStartISO,
      }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(prisma.appointment.updateMany).not.toHaveBeenCalled();
  });

  it('los movimientos del staff NO gastan el cupo del paciente', async () => {
    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });

    const data = prisma.appointment.update.mock.calls[0][0].data;
    expect(data.rescheduleCount).toEqual({ increment: 1 });
    expect(data).not.toHaveProperty('patientRescheduleCount');
  });

  it('el tope del paciente va en el WHERE del update, no en un if previo', async () => {
    prisma.appointment.updateMany.mockResolvedValue({ count: 1 });

    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
      byPatient: true,
      maxPatientReschedules: 3,
    });

    const where = prisma.appointment.updateMany.mock.calls[0][0].where;
    expect(where.patientRescheduleCount).toEqual({ lt: 3 });
    expect(where.clinicId).toBe('clinic-A');
  });

  it('tope alcanzado → 409 sin escribir nada (lo decide el WHERE)', async () => {
    prisma.appointment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.rescheduleAppointment({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: newStartISO,
        byPatient: true,
        maxPatientReschedules: 3,
      }),
    ).rejects.toThrow(/tope de reagendamientos/);
  });

  it.each(['ATENDIDA', 'CANCELADA', 'NO_SHOW'])(
    'estado terminal %s → 422 dentro del servicio, no solo en el caller',
    async (status) => {
      // Desde S6 reagendar muta el estado, así que el servicio ya no puede
      // confiar en que el caller validó: resucitaría una cita terminal.
      prisma.appointment.findFirst.mockResolvedValue({
        id: 'appt-1',
        clinicId: 'clinic-A',
        status,
        startAt: new Date('2030-06-01T14:00:00.000Z'),
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        service: { durationMin: 30 },
        clinic: { timezone: 'America/Caracas' },
      });

      await expect(
        service.rescheduleAppointment({
          clinicId: 'clinic-A',
          appointmentId: 'appt-1',
          startAtISO: newStartISO,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    },
  );

  it('incrementa rescheduleCount y sella lastRescheduledAt', async () => {
    // El contador es la señal del "reagendador reincidente": el estado no
    // sirve para eso porque cada movimiento lo devuelve a PENDIENTE.
    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: newStartISO,
    });

    const data = prisma.appointment.update.mock.calls[0][0].data;
    expect(data.rescheduleCount).toEqual({ increment: 1 });
    expect(data.lastRescheduledAt).toBeInstanceOf(Date);
  });

  it('el no-op (mismo instante) NO cuenta como reagendamiento', async () => {
    // Un "guardar" sin cambios reales no debe gastar el cupo del paciente ni
    // ensuciar la señal de riesgo.
    const sameInstantISO = '2030-06-01T14:00:00.000Z';
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'appt-1',
      clinicId: 'clinic-A',
      status: 'PENDIENTE',
      startAt: new Date(sameInstantISO),
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      service: { durationMin: 30 },
      clinic: { timezone: 'America/Caracas' },
    });

    await service.rescheduleAppointment({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
      startAtISO: sameInstantISO,
    });

    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(reminders.scheduleForAppointment).not.toHaveBeenCalled();
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
        // El UPDATE lleva la condición dentro (anti lost-update): devuelve
        // count 1 cuando la cita era cancelable.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(makeAppt()),
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue(makeAppt({ status: 'CANCELADA', canceledAt: new Date() })),
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
    expect(prisma.appointment.updateMany.mock.calls[0][0].data.canceledAt).toBeInstanceOf(Date);
    // Un recordatorio de una cita cancelada solo puede hacer daño.
    expect(reminders.cancelForAppointment).toHaveBeenCalledWith('appt-1');
  });

  it('la condición va DENTRO del UPDATE: no hay ventana de lost-update', async () => {
    // Si la recepcionista marca ATENDIDA entre la lectura y la escritura, un
    // update incondicional la pisaría y dejaría una transición imposible.
    await service.cancelByPatient({ clinicId: 'clinic-A', appointmentId: 'appt-1' });

    const where = prisma.appointment.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('appt-1');
    expect(where.clinicId).toBe('clinic-A');
    expect(where.status.in).toEqual(['PENDIENTE', 'CONFIRMADA', 'EN_RIESGO']);
    expect(where.startAt.gt).toBeInstanceOf(Date);
  });

  it('multi-tenant: el UPDATE va SIEMPRE acotado por clinicId', async () => {
    await service.cancelByPatient({ clinicId: 'clinic-A', appointmentId: 'appt-1' });

    expect(prisma.appointment.updateMany.mock.calls[0][0].where.clinicId).toBe('clinic-A');
  });

  it('cita de otra clínica → 404, nunca se cancela', async () => {
    prisma.appointment.updateMany.mockResolvedValue({ count: 0 });
    prisma.appointment.findFirst.mockResolvedValue(null);

    await expect(
      service.cancelByPatient({ clinicId: 'clinic-B', appointmentId: 'appt-1' }),
    ).rejects.toThrow(NotFoundException);
    expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
  });

  it('es idempotente: cancelar dos veces no re-cancela recordatorios', async () => {
    prisma.appointment.updateMany.mockResolvedValue({ count: 0 });
    prisma.appointment.findFirst.mockResolvedValue(makeAppt({ status: 'CANCELADA' }));

    const res = await service.cancelByPatient({
      clinicId: 'clinic-A',
      appointmentId: 'appt-1',
    });

    expect(res.status).toBe('CANCELADA');
    expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
  });

  it.each(['ATENDIDA', 'NO_SHOW'])(
    'estado terminal %s → 409: cambiarlo falsearía el histórico',
    async (status) => {
      // El propio UPDATE no matchea (su where excluye los terminales).
      prisma.appointment.updateMany.mockResolvedValue({ count: 0 });
      prisma.appointment.findFirst.mockResolvedValue(makeAppt({ status }));

      await expect(
        service.cancelByPatient({ clinicId: 'clinic-A', appointmentId: 'appt-1' }),
      ).rejects.toThrow(ConflictException);
      expect(reminders.cancelForAppointment).not.toHaveBeenCalled();
    },
  );

  it('cita ya pasada → 409 aunque el estado siga PENDIENTE', async () => {
    prisma.appointment.updateMany.mockResolvedValue({ count: 0 });
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
