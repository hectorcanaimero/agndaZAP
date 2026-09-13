import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { PatientWhatsappNotifier } from './patient-whatsapp-notifier.service';

describe('PatientWhatsappNotifier (ADR 0023)', () => {
  let prisma: any;
  let waha: { sendText: jest.Mock };
  /** Redis en memoria: `SET NX` e `INCR` de verdad, para que dedupe y tope se prueben. */
  let redisStore: Map<string, string>;
  let redis: { set: jest.Mock; incr: jest.Mock; expire: jest.Mock };
  let notifier: PatientWhatsappNotifier;

  const appt = (overrides: Record<string, unknown> = {}) => ({
    status: 'PENDIENTE',
    // 14:00 UTC = 10:00 en Caracas (UTC-4).
    startAt: new Date('2030-06-03T14:00:00Z'),
    patientId: 'pat-1',
    conversationId: null,
    patient: { phone: '+584141234567' },
    service: { name: 'Control' },
    professional: { name: 'Dra. Ana Ríos' },
    clinic: {
      name: 'Clínica A',
      address: 'Av. Principal 123',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'clinic-a-session',
    },
    ...overrides,
  });

  const MANAGE = 'https://showly.us/es/agendar/clinica-a/cita?t=mtok';

  beforeEach(() => {
    prisma = {
      appointment: { findFirst: jest.fn().mockResolvedValue(appt()) },
      conversation: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'convo-1', chatId: '584141234567@c.us' }),
      },
      message: {
        create: jest.fn().mockResolvedValue({}),
        // Mensaje entrante reciente: el paciente escribió hoy.
        findFirst: jest.fn().mockResolvedValue({ id: 'msg-in' }),
      },
    };
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };
    redisStore = new Map();
    redis = {
      set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes('NX') && redisStore.has(key)) return null;
        redisStore.set(key, value);
        return 'OK';
      }),
      incr: jest.fn(async (key: string) => {
        const next = Number(redisStore.get(key) ?? 0) + 1;
        redisStore.set(key, String(next));
        return next;
      }),
      expire: jest.fn().mockResolvedValue(1),
    };
    notifier = new PatientWhatsappNotifier(
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
      redis as any,
    );
  });

  const notify = (kind: 'created' | 'rescheduled' | 'canceled', manageUrl?: string) =>
    notifier.notify({ clinicId: 'clinic-A', appointmentId: 'appt-1', kind, manageUrl });

  it('al crear: confirmación con fecha en la TZ de la clínica y link de gestión, y queda como OUT', async () => {
    expect(await notify('created', MANAGE)).toBe(true);

    const [session, chatId, text] = waha.sendText.mock.calls[0];
    expect(session).toBe('clinic-a-session');
    expect(chatId).toBe('584141234567@c.us');
    expect(text).toContain('Control');
    expect(text).toContain('Dra. Ana Ríos');
    expect(text).toContain('agendada');
    expect(text).toContain('lunes 3 de junio a las 10:00');
    expect(text).toContain(MANAGE);
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { conversationId: 'convo-1', direction: 'OUT', body: text },
    });
  });

  it('la cita y la conversación se buscan dentro del tenant', async () => {
    await notify('created', MANAGE);

    expect(prisma.appointment.findFirst.mock.calls[0][0].where).toEqual({
      id: 'appt-1',
      clinicId: 'clinic-A',
    });
    expect(prisma.conversation.findFirst.mock.calls[0][0].where).toEqual({
      clinicId: 'clinic-A',
      OR: [{ patientId: 'pat-1' }, { phone: '+584141234567' }],
    });
  });

  it('cita nacida de un chat (@lid incluido): usa ESA conversación, no la búsqueda por teléfono', async () => {
    prisma.appointment.findFirst.mockResolvedValue(appt({ conversationId: 'convo-lid' }));
    prisma.conversation.findFirst.mockResolvedValue({ id: 'convo-lid', chatId: 'abc123@lid' });

    await notify('created', MANAGE);

    expect(prisma.conversation.findFirst.mock.calls[0][0].where).toEqual({
      id: 'convo-lid',
      clinicId: 'clinic-A',
    });
    expect(waha.sendText.mock.calls[0][1]).toBe('abc123@lid');
  });

  it('sin conversación con la clínica no escribe a nadie', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    expect(await notify('created', MANAGE)).toBe(false);
    expect(waha.sendText).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('cita de otra clínica (o inexistente): no hace nada', async () => {
    prisma.appointment.findFirst.mockResolvedValue(null);

    expect(await notify('canceled')).toBe(false);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(waha.sendText).not.toHaveBeenCalled();
  });

  it('al mover: dice "movida" con el horario nuevo', async () => {
    await notify('rescheduled', MANAGE);

    const text = waha.sendText.mock.calls[0][2];
    expect(text).toContain('movida');
    expect(text).toContain(MANAGE);
  });

  it('confirmada por la clínica (autoConfirm): dice "confirmada"', async () => {
    prisma.appointment.findFirst.mockResolvedValue(appt({ status: 'CONFIRMADA' }));

    await notify('created', MANAGE);

    expect(waha.sendText.mock.calls[0][2]).toContain('confirmada');
  });

  it('al cancelar: el texto de cita cancelada, que invita a *agendar*', async () => {
    await notify('canceled');

    const text = waha.sendText.mock.calls[0][2];
    expect(text).toContain('cancelada');
    expect(text).toContain('*agendar*');
  });

  it('en portugués si la clínica es pt', async () => {
    prisma.appointment.findFirst.mockResolvedValue(
      appt({ clinic: { ...appt().clinic, locale: 'pt' } }),
    );

    await notify('canceled');

    expect(waha.sendText.mock.calls[0][2]).toContain('Sua consulta foi cancelada');
  });

  describe('anti-spam (auditoría A1)', () => {
    it('conversación hallada por teléfono y sin mensajes en 24 h: no avisa', async () => {
      // El teléfono lo pudo escribir un tercero en el formulario público.
      prisma.message.findFirst.mockResolvedValue(null);

      expect(await notify('created', MANAGE)).toBe(false);
      expect(waha.sendText).not.toHaveBeenCalled();
      const where = prisma.message.findFirst.mock.calls[0][0].where;
      expect(where.conversationId).toBe('convo-1');
      expect(where.direction).toBe('IN');
      const hours = (Date.now() - where.createdAt.gte.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(24, 1);
    });

    it('conversación de la cita (token verificado): avisa sin exigir mensajes recientes', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appt({ conversationId: 'convo-1' }));
      prisma.message.findFirst.mockResolvedValue(null);

      expect(await notify('created', MANAGE)).toBe(true);
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it('el mismo aviso dos veces (cancelaciones simultáneas) sale una vez', async () => {
      expect(await notify('canceled')).toBe(true);
      expect(await notify('canceled')).toBe(false);
      expect(waha.sendText).toHaveBeenCalledTimes(1);
    });

    it('dos cambios de horario legítimos avisan dos veces', async () => {
      await notify('rescheduled', MANAGE);
      prisma.appointment.findFirst.mockResolvedValue(
        appt({ startAt: new Date('2030-06-04T14:00:00Z') }),
      );
      await notify('rescheduled', MANAGE);

      expect(waha.sendText).toHaveBeenCalledTimes(2);
    });

    it(`como mucho ${PatientWhatsappNotifier.MAX_PER_CONVERSATION_PER_HOUR} avisos por hora a la misma conversación`, async () => {
      jest.spyOn((notifier as any).logger, 'warn').mockImplementation(() => undefined);
      const sent: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        prisma.appointment.findFirst.mockResolvedValue(
          appt({ startAt: new Date(Date.UTC(2030, 5, 3, 14 + i)) }),
        );
        sent.push(await notify('created', MANAGE));
      }

      expect(sent).toEqual([true, true, true, true, false, false]);
      expect(redis.expire).toHaveBeenCalledWith('notice:conv:clinic-A:convo-1', 3600);
    });

    it('Redis caído: no avisa (fail-closed)', async () => {
      redis.set.mockRejectedValue(new Error('redis down'));
      jest.spyOn((notifier as any).logger, 'warn').mockImplementation(() => undefined);

      expect(await notify('created', MANAGE)).toBe(false);
      expect(waha.sendText).not.toHaveBeenCalled();
    });
  });

  it('error de Prisma con el texto dentro: el log no lleva el mensaje (B1)', async () => {
    const leaky = Object.assign(
      new Error(`Invalid prisma.message.create() body: "cita ... ${MANAGE}" 584141234567`),
      { name: 'PrismaClientValidationError' },
    );
    prisma.message.create.mockRejectedValue(leaky);
    const warn = jest
      .spyOn((notifier as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await notify('created', MANAGE);

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('err=PrismaClientValidationError');
    expect(logged).not.toContain('mtok');
    expect(logged).not.toContain('584141234567');
  });

  it('WAHA caído: no lanza, no persiste un OUT que nunca salió y no filtra PII al log', async () => {
    waha.sendText.mockRejectedValue(new Error('WAHA sendText 500'));
    const warn = jest
      .spyOn((notifier as any).logger, 'warn')
      .mockImplementation(() => undefined);

    expect(await notify('created', MANAGE)).toBe(false);
    expect(prisma.message.create).not.toHaveBeenCalled();

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('apptId=appt-1');
    expect(logged).not.toContain('584141234567');
    expect(logged).not.toContain('Ana');
  });

  it('la base de datos caída tampoco lanza', async () => {
    prisma.appointment.findFirst.mockRejectedValue(new Error('db down'));
    jest.spyOn((notifier as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(notify('created', MANAGE)).resolves.toBe(false);
  });
});
