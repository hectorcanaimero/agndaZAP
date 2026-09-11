import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { BotService } from './bot.service';
import {
  createBotInboundWorker,
  safeErrorLabel,
} from './bot-inbound.processor';
import { BOT_INBOUND_JOB, type BotInboundJobData } from './bot-inbound.queue';

/**
 * Tests del worker de mensajes entrantes (B10). Mockeamos `bullmq.Worker` para
 * capturar el processor y ejecutarlo con jobs sintéticos, igual que
 * `follow-ups.processor.spec.ts`.
 */

jest.mock('bullmq', () => ({
  Worker: jest
    .fn()
    .mockImplementation((name: string, processor: any, opts: any) => ({
      name,
      processor,
      opts,
    })),
  Job: class {},
}));

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('../common/sentry/sentry.config', () => ({
  isSentryEnabled: () => true,
}));

const DATA: BotInboundJobData = {
  clinicId: 'clinic-A',
  chatId: '584141234567@c.us',
  phone: '+584141234567',
  lid: null,
  contactName: 'Ana',
  text: 'hola, quiero agendar',
  requestId: 'req-1',
};

function makeJob(overrides: Record<string, any> = {}) {
  return {
    name: BOT_INBOUND_JOB,
    id: 'job-1',
    data: DATA,
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  };
}

describe('createBotInboundWorker', () => {
  let bot: { handleIncoming: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let processor: (job: any) => Promise<unknown>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    bot = { handleIncoming: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      clinic: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const worker = createBotInboundWorker(
      { host: 'localhost', port: 6379 },
      bot as unknown as BotService,
      prisma as unknown as PrismaService,
    ) as unknown as { processor: (job: any) => Promise<unknown> };
    processor = worker.processor;
  });

  afterEach(() => jest.restoreAllMocks());

  it('pasa el payload del job a BotService.handleIncoming', async () => {
    await processor(makeJob());

    expect(bot.handleIncoming).toHaveBeenCalledWith({
      clinicId: 'clinic-A',
      chatId: '584141234567@c.us',
      phone: '+584141234567',
      lid: null,
      contactName: 'Ana',
      text: 'hola, quiero agendar',
    });
    // `requestId` es para el contexto de logs, no un argumento del bot.
    expect(bot.handleIncoming.mock.calls[0][0]).not.toHaveProperty('requestId');
  });

  it('corre dentro del requestContext con el requestId del job', async () => {
    let seen: unknown;
    bot.handleIncoming.mockImplementation(async () => {
      seen = requestContext.getStore();
    });

    await processor(makeJob());

    expect(seen).toMatchObject({ requestId: 'req-1', clinicId: 'clinic-A' });
  });

  it('sin requestId en el job genera uno: el log siempre es correlacionable', async () => {
    let seen: any;
    bot.handleIncoming.mockImplementation(async () => {
      seen = requestContext.getStore();
    });

    await processor(makeJob({ data: { ...DATA, requestId: undefined } }));

    expect(seen.requestId).toEqual(expect.any(String));
    expect(seen.requestId.length).toBeGreaterThan(0);
  });

  it('ignora jobs de otro nombre sin tocar el bot', async () => {
    await processor(makeJob({ name: 'otra-cosa' }));
    expect(bot.handleIncoming).not.toHaveBeenCalled();
  });

  it('propaga el error para que BullMQ reintente', async () => {
    bot.handleIncoming.mockRejectedValue(new Error('deepseek down'));
    await expect(processor(makeJob())).rejects.toThrow('deepseek down');
  });

  describe('reporte de fallos', () => {
    it('un intento intermedio NO reporta a Sentry ni loguea error', async () => {
      // Si BullMQ va a reintentar, un error transitorio no merece despertar a
      // nadie: el mensaje todavía puede salir adelante.
      bot.handleIncoming.mockRejectedValue(new Error('timeout'));

      await expect(
        processor(makeJob({ attemptsMade: 0 })),
      ).rejects.toThrow();

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('el último intento sí reporta: ese mensaje ya no se procesa nunca', async () => {
      bot.handleIncoming.mockRejectedValue(new Error('deepseek down'));

      await expect(
        processor(makeJob({ attemptsMade: 2 })),
      ).rejects.toThrow();

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('descartado'),
      );
    });

    it('no manda el texto del paciente ni el chatId a Sentry', async () => {
      bot.handleIncoming.mockRejectedValue(new Error('boom'));
      await expect(processor(makeJob({ attemptsMade: 2 }))).rejects.toThrow();

      const payload = JSON.stringify(
        (Sentry.captureException as jest.Mock).mock.calls[0][1],
      );
      expect(payload).not.toContain('584141234567');
      expect(payload).not.toContain('quiero agendar');
    });

    it('el log del descarte tampoco lleva PII', async () => {
      bot.handleIncoming.mockRejectedValue(new Error('boom'));
      await expect(processor(makeJob({ attemptsMade: 2 }))).rejects.toThrow();

      for (const call of errorSpy.mock.calls) {
        const msg = String(call[0]);
        expect(msg).not.toContain('584141234567');
        expect(msg).not.toContain('quiero agendar');
      }
    });
  });

  describe('revalidación de la clínica', () => {
    it('clínica suspendida entre encolar y procesar: descarta sin llamar al bot', async () => {
      // El webhook comprobó ACTIVE al encolar, pero la cola puede venir
      // atrasada o la clínica haberse suspendido mientras tanto.
      prisma.clinic.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
      await processor(makeJob());
      expect(bot.handleIncoming).not.toHaveBeenCalled();
    });

    it('clínica borrada: tampoco llama al bot', async () => {
      prisma.clinic.findUnique.mockResolvedValue(null);
      await processor(makeJob());
      expect(bot.handleIncoming).not.toHaveBeenCalled();
    });
  });

  describe('el último intento deja rastro para la clínica', () => {
    it('marca la conversación NEEDS_HUMAN para que salga en el triaje', async () => {
      bot.handleIncoming.mockRejectedValue(new Error('boom'));
      await expect(processor(makeJob({ attemptsMade: 2 }))).rejects.toThrow();

      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { clinicId: 'clinic-A', chatId: DATA.chatId, state: 'BOT' },
        data: { state: 'NEEDS_HUMAN' },
      });
    });

    it('un intento intermedio no la marca todavía', async () => {
      bot.handleIncoming.mockRejectedValue(new Error('boom'));
      await expect(processor(makeJob({ attemptsMade: 0 }))).rejects.toThrow();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });

    it('si marcarla falla, no tapa el error original', async () => {
      bot.handleIncoming.mockRejectedValue(new Error('original'));
      prisma.conversation.updateMany.mockRejectedValue(new Error('db down'));
      await expect(processor(makeJob({ attemptsMade: 2 }))).rejects.toThrow(
        'original',
      );
    });
  });

  /**
   * El texto del paciente no se escapa sólo por `job.data`: los errores de
   * validación de Prisma imprimen los argumentos de la invocación, y
   * `handleIncoming` hace `message.create({ body: text })`. Ese string acabaría
   * a la vez en Redis (failedReason), en Axiom y en Sentry.
   */
  describe('safeErrorLabel', () => {
    it('de un error de Prisma se queda con nombre y código, sin mensaje', () => {
      const err = Object.assign(
        new Error(
          'Invalid `prisma.message.create()` invocation: { body: "tengo dolor de muelas" }',
        ),
        { name: 'PrismaClientValidationError', code: 'P2000' },
      );
      const label = safeErrorLabel(err);

      expect(label).toBe('PrismaClientValidationError:P2000');
      expect(label).not.toContain('dolor de muelas');
    });

    it('un error normal conserva el mensaje, acotado', () => {
      expect(safeErrorLabel(new Error('deepseek timeout'))).toBe(
        'deepseek timeout',
      );
      expect(safeErrorLabel(new Error('x'.repeat(500)))).toHaveLength(200);
    });

    it('aguanta un error que no es Error', () => {
      expect(safeErrorLabel(undefined)).toBe('unknown');
      expect(safeErrorLabel('texto suelto')).toBe('unknown');
    });
  });

  it('un error de Prisma con el texto del paciente no llega ni a Sentry ni al log', async () => {
    const err = Object.assign(
      new Error(
        'Invalid `prisma.message.create()` invocation: body: "me duele la muela"',
      ),
      { name: 'PrismaClientValidationError', code: 'P2000' },
    );
    bot.handleIncoming.mockRejectedValue(err);

    await expect(processor(makeJob({ attemptsMade: 2 }))).rejects.toThrow();

    const sentryArgs = JSON.stringify(
      (Sentry.captureException as jest.Mock).mock.calls[0],
    );
    const captured = (Sentry.captureException as jest.Mock).mock.calls[0][0];
    expect(captured.message).toBe('PrismaClientValidationError:P2000');
    expect(sentryArgs).not.toContain('me duele la muela');
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toContain('me duele la muela');
    }
  });
});
