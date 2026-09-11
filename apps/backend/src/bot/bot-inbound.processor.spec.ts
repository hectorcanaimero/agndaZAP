import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { BotService } from './bot.service';
import {
  createBotInboundWorker,
  safeErrorLabel,
} from './bot-inbound.processor';
import { recordBotTurn } from './bot-turn-context';
import { Intent } from './intent.service';
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
  timezone: 'America/Caracas',
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redisCalls: any[][];
  let logSpy: jest.SpyInstance;
  let processor: (job: any) => Promise<unknown>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    redisCalls = [];
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    bot = { handleIncoming: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      clinic: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    redis = {
      pipeline: jest.fn(() => {
        const calls: any[] = [];
        const chain: any = {
          hincrby: jest.fn((...a: any[]) => {
            calls.push(['hincrby', ...a]);
            return chain;
          }),
          expire: jest.fn((...a: any[]) => {
            calls.push(['expire', ...a]);
            return chain;
          }),
          exec: jest.fn(async () => calls),
        };
        redisCalls.push(calls);
        return chain;
      }),
    };
    const worker = createBotInboundWorker(
      { host: 'localhost', port: 6379 },
      bot as unknown as BotService,
      prisma as unknown as PrismaService,
      redis as unknown as never,
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

  /** M9: una línea estructurada por turno, sin PII. */
  describe('evento bot.turn', () => {
    function lastEvent() {
      const calls = logSpy.mock.calls.filter(
        (c) => typeof c[0] === 'object' && c[0]?.event === 'bot.turn',
      );
      return calls.at(-1)?.[0];
    }

    it('emite un bot.turn por turno con outcome ok y latencia', async () => {
      await processor(makeJob());
      const e = lastEvent();

      expect(e).toMatchObject({
        event: 'bot.turn',
        clinicId: 'clinic-A',
        outcome: 'ok',
        requestId: 'req-1',
      });
      expect(typeof e.latencyMs).toBe('number');
    });

    it('el chatId va hasheado, nunca en claro', async () => {
      await processor(makeJob());
      const e = lastEvent();

      expect(e.chatHash).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(e)).not.toContain('584141234567');
    });

    it('no filtra el texto del paciente', async () => {
      await processor(makeJob());
      expect(JSON.stringify(lastEvent())).not.toContain('quiero agendar');
    });

    it('un turno que falla también emite, con outcome error', async () => {
      // Es justo el turno que más interesa observar.
      bot.handleIncoming.mockRejectedValue(new Error('deepseek down'));
      await expect(processor(makeJob())).rejects.toThrow();

      // `reasonCode`, no el mensaje del error: éste puede arrastrar el texto
      // del paciente (los errores de JSON.parse incluyen parte de la entrada).
      expect(lastEvent()).toMatchObject({
        outcome: 'error',
        reasonCode: 'bot-error',
      });
    });

    it('una clínica suspendida emite skipped y no llega al bot', async () => {
      prisma.clinic.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
      await processor(makeJob());

      expect(lastEvent()).toMatchObject({
        outcome: 'skipped',
        reasonCode: 'clinica-no-activa',
      });
      expect(bot.handleIncoming).not.toHaveBeenCalled();
    });

    it('incluye lo que BotService anotó en el contexto del turno', async () => {
      bot.handleIncoming.mockImplementation(async () => {
        recordBotTurn({ intent: Intent.AGENDAR, source: 'rule', handoff: false });
      });
      await processor(makeJob());

      expect(lastEvent()).toMatchObject({
        intent: Intent.AGENDAR,
        source: 'rule',
        handoff: false,
      });
    });

    it('omite los campos que el turno no llegó a rellenar', async () => {
      // Un `intent: undefined` en Axiom parece un dato ausente cuando en
      // realidad el camino ni pasó por el clasificador.
      await processor(makeJob());
      expect(lastEvent()).not.toHaveProperty('intent');
      expect(lastEvent()).not.toHaveProperty('rag');
    });

    it('suma los contadores del día que lee el dashboard', async () => {
      bot.handleIncoming.mockImplementation(async () => {
        recordBotTurn({ intent: Intent.AGENDAR, source: 'llm' });
      });
      await processor(makeJob());

      const ops = redisCalls.at(-1) ?? [];
      const fields = ops
        .filter((o) => o[0] === 'hincrby')
        .map((o) => o[2]);
      expect(fields).toEqual(
        expect.arrayContaining(['turns', 'outcome:ok', 'intent:agendar', 'source:llm']),
      );
      expect(ops.some((o) => o[0] === 'expire')).toBe(true);
    });

    it('si los contadores fallan, el turno sigue adelante', async () => {
      redis.pipeline = jest.fn(() => {
        throw new Error('redis down');
      });
      await expect(processor(makeJob())).resolves.toBeUndefined();
      expect(bot.handleIncoming).toHaveBeenCalled();
    });
  });

  describe('reintentos y contadores', () => {
    it('los contadores sólo cuentan el primer intento', async () => {
      // BullMQ reintenta 3 veces: sin esto, un mensaje que falla dos veces y
      // acierta a la tercera sumaría 3 turnos y 2 errores para UN mensaje, y
      // el panel de la clínica mentiría sobre su propio volumen.
      redisCalls = [];
      bot.handleIncoming.mockRejectedValueOnce(new Error('timeout'));
      await expect(processor(makeJob({ attemptsMade: 1 }))).rejects.toThrow();
      expect(redisCalls).toHaveLength(0);
    });

    it('pero el evento sí se emite en cada intento, con el número', async () => {
      bot.handleIncoming.mockRejectedValueOnce(new Error('timeout'));
      await expect(processor(makeJob({ attemptsMade: 1 }))).rejects.toThrow();
      const e = logSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.event === 'bot.turn')
        .at(-1);
      expect(e).toMatchObject({ outcome: 'error', attempt: 2 });
    });

    it('el primer intento no lleva `attempt`: sería ruido en cada línea', async () => {
      await processor(makeJob());
      const e = logSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.event === 'bot.turn')
        .at(-1);
      expect(e).not.toHaveProperty('attempt');
    });

    it('si la base falla antes del bot, igual se emite un evento', async () => {
      // Si no, durante una caída de Postgres el panel muestra cero turnos y
      // cero errores: indistinguible de "no escribió nadie".
      prisma.clinic.findUnique.mockRejectedValue(new Error('db down'));
      await expect(processor(makeJob())).rejects.toThrow('db down');
      const e = logSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.event === 'bot.turn')
        .at(-1);
      expect(e).toMatchObject({ outcome: 'error', reasonCode: 'bot-error' });
    });

    it('un turno que lanza un valor falsy no se lee como exitoso', async () => {
      // `throw null` con `if (error)` habría emitido ok y marcado el job como
      // completado, dejando al paciente sin respuesta y sin rastro.
      bot.handleIncoming.mockImplementation(() => Promise.reject(null));
      await expect(processor(makeJob())).rejects.toBeNull();
      const e = logSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.event === 'bot.turn')
        .at(-1);
      expect(e.outcome).toBe('error');
    });
  });
});
