import { PrismaService } from '../prisma/prisma.service';
import { alertReception } from './reception-alert';

/**
 * Helper compartido entre el worker de recordatorios (cita EN_RIESGO) y los
 * endpoints de gestión por link (cancelación / cambio de horario).
 *
 * Está extraído precisamente para que la resolución de conversación viva en un
 * solo sitio: duplicarla ya costó un bug (ver la nota del chatId canónico).
 */
describe('alertReception', () => {
  function makePrisma(conversation: { id: string } | null = { id: 'convo-1' }) {
    return {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService & any;
  }

  const BASE = {
    clinicId: 'clinic-A',
    patientId: 'pat-1',
    phone: '+584141234567',
    body: 'aviso',
  };

  it('escribe el aviso como mensaje OUT en la conversación del paciente', async () => {
    const prisma = makePrisma();

    const ok = await alertReception(prisma, { ...BASE, needsHuman: false });

    expect(ok).toBe(true);
    const { data } = prisma.conversation.update.mock.calls[0][0];
    expect(data.messages.create).toEqual({ direction: 'OUT', body: 'aviso' });
  });

  it('busca por patientId O phone, con orderBy updatedAt desc', async () => {
    // Mismo criterio que el resto del sistema: un paciente puede tener dos
    // filas (una @lid y una @c.us) y sin el orderBy Postgres devuelve cualquiera.
    const prisma = makePrisma();

    await alertReception(prisma, { ...BASE, needsHuman: false });

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        clinicId: 'clinic-A',
        OR: [{ patientId: 'pat-1' }, { phone: '+584141234567' }],
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
  });

  it('needsHuman false NO saca la conversación del bot', async () => {
    // Si marcáramos todo como NEEDS_HUMAN, la bandeja se llenaría de hilos que
    // nadie tiene que atender y el aviso dejaría de significar nada.
    const prisma = makePrisma();

    await alertReception(prisma, { ...BASE, needsHuman: false });

    const { data } = prisma.conversation.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('state');
    expect(data).not.toHaveProperty('flowStep');
  });

  it('needsHuman true marca NEEDS_HUMAN y limpia la FSM', async () => {
    const prisma = makePrisma();

    await alertReception(prisma, { ...BASE, needsHuman: true });

    const { data } = prisma.conversation.update.mock.calls[0][0];
    expect(data.state).toBe('NEEDS_HUMAN');
    expect(data.flowStep).toBeNull();
  });

  it('sin conversación devuelve false y no escribe nada', async () => {
    // Paciente que agendó por la web y nunca escribió por WhatsApp.
    const prisma = makePrisma(null);

    const ok = await alertReception(prisma, { ...BASE, needsHuman: true });

    expect(ok).toBe(false);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('los errores de escritura SE PROPAGAN: cada caller decide qué hacer', async () => {
    // El worker de recordatorios los deja subir para que BullMQ reintente; los
    // endpoints de gestión los capturan porque la cancelación ya está hecha.
    // Tragárselos aquí le quitaría esa decisión a quien llama.
    const prisma = makePrisma();
    prisma.conversation.update.mockRejectedValue(new Error('db down'));

    await expect(
      alertReception(prisma, { ...BASE, needsHuman: false }),
    ).rejects.toThrow('db down');
  });
});
