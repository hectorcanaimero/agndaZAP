import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { PatientWhatsappNotifier } from './patient-whatsapp-notifier.service';

describe('PatientWhatsappNotifier (ADR 0023)', () => {
  let prisma: any;
  let waha: { sendText: jest.Mock };
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
      message: { create: jest.fn().mockResolvedValue({}) },
    };
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };
    notifier = new PatientWhatsappNotifier(
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
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
