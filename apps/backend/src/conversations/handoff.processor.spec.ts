import { Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { createHandoffWorker } from './handoff.processor';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_queue, processor) => ({ processor })),
}));

describe('HandoffProcessor (M7)', () => {
  let prisma: any;
  let waha: any;
  let process: (job: any) => Promise<void>;

  const convo = {
    id: 'convo-1',
    clinicId: 'clinic-A',
    chatId: '5804141234567@c.us',
    state: 'NEEDS_HUMAN',
    clinic: { wahaSession: 'clinic-a-session' },
  };

  const job = { data: { conversationId: 'convo-1', clinicId: 'clinic-A' } };

  beforeEach(() => {
    prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(convo),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: { create: jest.fn().mockResolvedValue({}) },
    };
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };

    const worker = createHandoffWorker(
      { host: 'localhost', port: 6379 },
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
    ) as any;
    process = worker.processor;
  });

  afterEach(() => jest.clearAllMocks());

  it('devuelve la conversación al bot y avisa al paciente', async () => {
    await process(job);

    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'convo-1', clinicId: 'clinic-A', state: 'NEEDS_HUMAN' },
      data: { state: 'BOT' },
    });
    const [session, chatId, text] = waha.sendText.mock.calls[0];
    expect(session).toBe('clinic-a-session');
    expect(chatId).toBe('5804141234567@c.us');
    expect(text).toMatch(/\*agendar\*/);
    // Deja la puerta abierta a volver a pedir una persona.
    expect(text).toMatch(/\*humano\*/);
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { conversationId: 'convo-1', direction: 'OUT', body: text },
    });
  });

  it('si alguien ya la tomó, no hace nada', async () => {
    // El estado en DB es la única fuente de verdad: por eso liberar desde el
    // panel no necesita cancelar el job.
    prisma.conversation.findFirst.mockResolvedValue({ ...convo, state: 'HUMAN' });

    await process(job);

    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(waha.sendText).not.toHaveBeenCalled();
  });

  it('conversación de otra clínica: no la toca', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await process(job);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'convo-1', clinicId: 'clinic-A' },
      }),
    );
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('si el aviso no sale, la conversación vuelve al bot igual', async () => {
    // Al revés sería peor: un fallo de red dejaría la conversación muda para
    // siempre.
    waha.sendText.mockRejectedValue(new Error('waha caído'));

    await expect(process(job)).resolves.toBeUndefined();

    expect(prisma.conversation.updateMany).toHaveBeenCalled();
  });

  it('el update lleva el estado en el where: no pisa a quien la tomó entre la lectura y la escritura', async () => {
    await process(job);

    const where = prisma.conversation.updateMany.mock.calls[0][0].where;
    expect(where.state).toBe('NEEDS_HUMAN');
  });
});

// El mock de Worker no se usa directamente, pero TS necesita la referencia.
void Worker;
