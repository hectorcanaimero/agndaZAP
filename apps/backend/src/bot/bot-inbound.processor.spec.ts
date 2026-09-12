import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { requestContext } from '../common/logger/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import {
  AudioTooLongError,
  MediaExpiredError,
  SttService,
  SttUnavailableError,
} from '../stt/stt.service';
import { BotService } from './bot.service';
import {
  createBotInboundWorker,
  safeErrorLabel,
} from './bot-inbound.processor';
import { recordBotTurn } from './bot-turn-context';
import { Intent } from './intent.service';
import { BOT_INBOUND_JOB, type BotInboundJobData } from './bot-inbound.queue';
import { VOICE_CONSENT_VERSION } from './bot.messages';

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
  let stt: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let waha: any;
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
      clinic: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', locale: 'es', wahaSession: 'c-a' }),
      },
      conversation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'convo-1',
          state: 'BOT',
          voiceConsentVersion: null,
        }),
      },
      message: {
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
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
    stt = { transcribe: jest.fn() };
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };
    const worker = createBotInboundWorker(
      { host: 'localhost', port: 6379 },
      bot as unknown as BotService,
      prisma as unknown as PrismaService,
      redis as unknown as never,
      stt as unknown as SttService,
      waha as unknown as WahaService,
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

  describe('lo que sale del worker hacia Redis', () => {
    it('el error que se relanza no lleva el texto del paciente', async () => {
      // BullMQ escribe `message` y `stacktrace` en el `failedReason` del job,
      // en un Redis sin cifrado at-rest. Un error de validación de Prisma
      // imprime los argumentos de la invocación — con el `body` del mensaje
      // dentro, y desde M10 eso puede ser la transcripción de una nota de voz.
      const err = Object.assign(
        new Error('Invalid `prisma.message.create()`: body: "me duele el pecho"'),
        { name: 'PrismaClientValidationError' },
      );
      bot.handleIncoming.mockRejectedValue(err);

      const lanzado: Error = await processor(makeJob()).then(
        () => {
          throw new Error('el worker tenía que relanzar');
        },
        (e) => e as Error,
      );

      expect(lanzado.message).not.toContain('me duele el pecho');
      // El `name` sí sobrevive: es lo que se mira para agrupar y depurar.
      expect(lanzado.name).toBe('PrismaClientValidationError');
    });
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
      // Sale saneado (un `Error` con el `name` original), nunca el valor
      // crudo: lo que se relanza es lo que BullMQ escribe en `failedReason`.
      // Lo que este test protege es que RECHACE, no la identidad del valor.
      await expect(processor(makeJob())).rejects.toBeTruthy();
      const e = logSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.event === 'bot.turn')
        .at(-1);
      expect(e.outcome).toBe('error');
    });
  });

  /**
   * M10: notas de voz. El texto transcrito entra al pipeline como si el
   * paciente lo hubiera escrito; si no se puede transcribir, se le deriva a una
   * persona en vez de dejarle sin respuesta.
   */
  describe('notas de voz', () => {
    let updateData: jest.Mock;

    const audioJob = (over: Record<string, any> = {}) =>
      makeJob({
        updateData,
        data: {
          ...DATA,
          text: '',
          audio: { url: 'http://waha:3000/api/files/a.oga', durationSec: 17 },
          ...over,
        },
      });

    beforeEach(() => {
      updateData = jest.fn().mockResolvedValue(undefined);
      // Los dos gates del camino de audio son de ENTORNO, no de argumentos:
      // si el test no los pone, el worker deriva a una persona y ningún
      // `expect` sobre la transcripción se cumpliría. Ver `isSttEnabled`.
      process.env.STT_ENABLED = 'true';
      process.env.OPENAI_API_KEY = 'sk-test';
      // Por defecto el paciente ya está avisado: estos tests van del camino de
      // transcripción. El aviso tiene su propio bloque.
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'convo-1',
        state: 'BOT',
        voiceConsentVersion: VOICE_CONSENT_VERSION,
      });
    });

    afterEach(() => {
      delete process.env.STT_ENABLED;
      delete process.env.OPENAI_API_KEY;
    });

    it('con el flag apagado NO se transcribe: se deriva a una persona', async () => {
      // El gate se mira otra vez aquí y no sólo al encolar. Apagarlo tiene que
      // parar también los jobs que ya estaban en la cola y los `retry` desde
      // el panel de BullMQ: si no, el kill switch de cumplimiento no mata.
      delete process.env.STT_ENABLED;
      // Con un `transcribe` que resuelve, si el gate desapareciera el test
      // fallaría por el gate y no por un TypeError aguas abajo: el mensaje de
      // fallo tiene que señalar al sitio correcto.
      stt.transcribe.mockResolvedValue({ text: 'x', model: 'm' });

      await expect(processor(audioJob())).resolves.toBeUndefined();

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(bot.handleIncoming).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { state: 'NEEDS_HUMAN' } }),
      );
      // Y se le dice algo. El webhook ya suprimió el "solo puedo leer texto"
      // al ver que había algo que transcribir: sin esto, apagar el flag deja
      // en silencio absoluto a todos los pacientes con un job en vuelo, justo
      // durante la respuesta a un incidente.
      expect(waha.sendText).toHaveBeenCalledWith(
        'c-a',
        DATA.chatId,
        expect.stringContaining('No pude escuchar'),
      );
    });

    it('guarda la transcripción en el job: el reintento no vuelve a pagarla', async () => {
      stt.transcribe.mockResolvedValue({ text: 'quiero una cita', model: 'm' });

      await processor(audioJob());

      expect(updateData).toHaveBeenCalledWith(
        expect.objectContaining({
          transcript: 'quiero una cita',
          transcriptModel: 'm',
        }),
      );
    });

    it('si el job ya trae la transcripción, no se llama al proveedor', async () => {
      // El caso real: la transcripción salió bien y lo que falló después fue
      // Postgres. Sin esto, cada reintento manda otra vez el audio a OpenAI —
      // y para entonces el fichero puede haber caducado ya.
      await processor(
        audioJob({ transcript: 'quiero una cita', transcriptModel: 'm' }),
      );

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(bot.handleIncoming).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'quiero una cita' }),
      );
    });

    it('transcribe y le pasa el texto al bot como si lo hubiera escrito', async () => {
      stt.transcribe.mockResolvedValue({ text: 'quiero una cita', model: 'm' });

      await processor(audioJob());

      expect(stt.transcribe).toHaveBeenCalledWith(
        'http://waha:3000/api/files/a.oga',
        expect.objectContaining({
          clinicId: 'clinic-A',
          durationSec: 17,
          // El idioma de la clínica sube la precisión.
          locale: 'es',
        }),
      );
      expect(bot.handleIncoming).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'quiero una cita' }),
      );
    });

    it('marca el turno como entrada de audio', async () => {
      stt.transcribe.mockResolvedValue({ text: 'hola', model: 'm' });
      bot.handleIncoming.mockImplementation(async () => {
        recordBotTurn({ intent: Intent.AGENDAR, source: 'rule' });
      });

      await processor(audioJob());

      const e = logSpy.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.event === 'bot.turn')
        .at(-1);
      // Campo aparte de `source`, que significa quién clasificó la intención:
      // el turno anota `source` desde dentro y los dos tienen que convivir.
      expect(e).toMatchObject({ inputKind: 'audio', source: 'rule' });
    });

    it('si alguien tomó el hilo mientras esperaba en la cola, no se transcribe', async () => {
      // El estado se revalida al procesar por lo mismo que el flag: entre
      // encolar y procesar hay cola, backoff y hasta 120 s de lock. Mandar la
      // grabación a un tercero para que la lea alguien que ya está leyendo el
      // hilo es gasto y divulgación sin beneficio para el paciente.
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'convo-1',
        state: 'HUMAN',
        voiceConsentVersion: null,
      });
      stt.transcribe.mockResolvedValue({ text: 'x', model: 'm' });

      await processor(audioJob());

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(bot.handleIncoming).not.toHaveBeenCalled();
      // Tampoco se le escribe: ya hay una persona en el hilo.
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('un mensaje de texto normal no pasa por el transcriptor', async () => {
      await processor(makeJob());
      expect(stt.transcribe).not.toHaveBeenCalled();
    });

    describe('aviso de que la transcribe una IA (consent, ADR 0004 §7.2)', () => {
      beforeEach(() => {
        // Todavía no se le ha avisado a este paciente.
        prisma.conversation.findFirst.mockResolvedValue({
          id: 'convo-1',
          state: 'BOT',
          voiceConsentVersion: null,
        });
        stt.transcribe.mockResolvedValue({ text: 'hola', model: 'm' });
      });

      it('se le avisa ANTES de mandarle el audio a nadie', async () => {
        await processor(audioJob());

        expect(waha.sendText).toHaveBeenCalledWith(
          'c-a',
          DATA.chatId,
          expect.stringContaining('OpenAI'),
        );
        // El orden es el punto entero: avisar después de transcribir no es
        // avisar, es contarlo.
        const avisoEn = waha.sendText.mock.invocationCallOrder[0];
        const transcribeEn = stt.transcribe.mock.invocationCallOrder[0];
        expect(avisoEn).toBeLessThan(transcribeEn);
      });

      it('queda en la bandeja: el Message OUT es la prueba de que se avisó', async () => {
        await processor(audioJob());

        expect(prisma.message.create).toHaveBeenCalledWith({
          data: {
            conversationId: 'convo-1',
            direction: 'OUT',
            body: expect.stringContaining('OpenAI'),
          },
        });
      });

      it('queda marcado en la conversación, que es la prueba que se enseña', async () => {
        // No vale el `Message OUT` con el texto: `BotService.reply` persiste la
        // respuesta del LLM verbatim y el copy es público, así que una
        // inyección de prompt podría plantar una fila idéntica sin que el aviso
        // saliera nunca. Una prueba fabricable no prueba nada.
        await processor(audioJob());

        expect(prisma.conversation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              voiceConsentVersion: VOICE_CONSENT_VERSION,
              voiceConsentAt: expect.any(Date),
            }),
          }),
        );
      });

      it('no se repite si la conversación ya lo tiene marcado', async () => {
        prisma.conversation.findFirst.mockResolvedValue({
          id: 'convo-1',
          state: 'BOT',
          voiceConsentVersion: VOICE_CONSENT_VERSION,
        });

        await processor(audioJob());

        expect(waha.sendText).not.toHaveBeenCalled();
        expect(stt.transcribe).toHaveBeenCalled();
      });

      it('se repite si cambió la versión del aviso', async () => {
        // Un consent viejo no cubre un texto nuevo.
        prisma.conversation.findFirst.mockResolvedValue({
          id: 'convo-1',
          state: 'BOT',
          voiceConsentVersion: 'v1',
        });

        await processor(audioJob());

        expect(waha.sendText).toHaveBeenCalledWith(
          'c-a',
          DATA.chatId,
          expect.stringContaining('OpenAI'),
        );
      });

      it('si el aviso salió pero no se pudo registrar, se transcribe igual', async () => {
        // El paciente YA lo recibió. Cortar aquí sería no transcribirle a
        // alguien a quien sí se avisó, y repetírselo en el próximo intento.
        prisma.conversation.updateMany.mockRejectedValue(new Error('db down'));

        await processor(audioJob());

        expect(stt.transcribe).toHaveBeenCalled();
      });

      it('si no se le puede avisar, NO se transcribe: se deriva', async () => {
        // Fail-closed en la dirección incómoda: sin aviso, su voz no sale
        // hacia un tercero. Repetir el aviso sería el error barato.
        waha.sendText.mockRejectedValue(new Error('waha down'));

        await expect(processor(audioJob())).resolves.toBeUndefined();

        expect(stt.transcribe).not.toHaveBeenCalled();
        expect(prisma.conversation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { state: 'NEEDS_HUMAN' } }),
        );
      });

      it('en el reintento de un audio ya transcrito no se vuelve a avisar', async () => {
        await processor(
          audioJob({ transcript: 'hola', transcriptModel: 'm' }),
        );

        expect(waha.sendText).not.toHaveBeenCalled();
      });

      it('el aviso sale en el idioma de la clínica', async () => {
        prisma.clinic.findUnique.mockResolvedValue({
          status: 'ACTIVE',
          locale: 'pt',
          wahaSession: 'c-a',
        });

        await processor(audioJob());

        expect(waha.sendText).toHaveBeenCalledWith(
          'c-a',
          DATA.chatId,
          expect.stringContaining('áudio'),
        );
      });
    });

    describe('cuando no se puede transcribir', () => {
      it('audio caducado: deriva a una persona y avisa, sin reintentar', async () => {
        // WAHA lo borró a los 900 s: reintentar no lo trae de vuelta, sólo
        // deja al paciente esperando más.
        stt.transcribe.mockRejectedValue(new MediaExpiredError());

        await expect(processor(audioJob())).resolves.toBeUndefined();

        expect(bot.handleIncoming).not.toHaveBeenCalled();
        expect(prisma.conversation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { state: 'NEEDS_HUMAN' } }),
        );
        expect(waha.sendText).toHaveBeenCalledWith(
          'c-a',
          DATA.chatId,
          expect.stringContaining('No pude escuchar'),
        );
      });

      it('el aviso de fallo sale en el idioma de la clínica', async () => {
        // Mandarle el consent en portugués y el fallo en español es peor que
        // no localizar nada: se nota que hay dos manos distintas.
        prisma.clinic.findUnique.mockResolvedValue({
          status: 'ACTIVE',
          locale: 'pt',
          wahaSession: 'c-a',
        });
        stt.transcribe.mockRejectedValue(new MediaExpiredError());

        await processor(audioJob());

        expect(waha.sendText).toHaveBeenCalledWith(
          'c-a',
          DATA.chatId,
          expect.stringContaining('Não consegui'),
        );
      });

      it('audio demasiado largo: el aviso le dice qué puede hacer', async () => {
        // "resúmemelo" tiene arreglo por su parte; "caducó" no.
        stt.transcribe.mockRejectedValue(new AudioTooLongError());

        await processor(audioJob());

        expect(waha.sendText).toHaveBeenCalledWith(
          'c-a',
          DATA.chatId,
          expect.stringContaining('resumes'),
        );
      });

      it('el evento registra el motivo y la derivación', async () => {
        stt.transcribe.mockRejectedValue(new MediaExpiredError());
        await processor(audioJob());

        const e = logSpy.mock.calls
          .map((c) => c[0])
          .filter((a) => a?.event === 'bot.turn')
          .at(-1);
        expect(e).toMatchObject({
          outcome: 'unsupported',
          reasonCode: 'audio-no-transcrito',
          inputKind: 'audio',
          handoff: true,
        });
      });

      it('un fallo de infraestructura SÍ se relanza, para que BullMQ reintente', async () => {
        // La diferencia importa: esto puede funcionar en el siguiente intento,
        // y la ventana de 900 s todavía da margen.
        stt.transcribe.mockRejectedValue(new SttUnavailableError());

        // Se relanza saneado: el `name` sobrevive —que es por lo que se agrupa
        // al depurar— y el `message` no, porque BullMQ lo guarda en Redis.
        await expect(processor(audioJob())).rejects.toMatchObject({
          name: 'SttUnavailableError',
        });
        expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      });

      it('sin OPENAI_API_KEY el fallo es definitivo, no se reintenta', async () => {
        // Es configuración, no una intermitencia. Tratarlo como transitorio
        // dejaría al paciente sin NINGUNA respuesta hasta agotar los intentos:
        // el webhook ya no le dijo "solo leo texto".
        delete process.env.OPENAI_API_KEY;
        stt.transcribe.mockRejectedValue(new SttUnavailableError());

        await expect(processor(audioJob())).resolves.toBeUndefined();

        expect(prisma.conversation.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { state: 'NEEDS_HUMAN' } }),
        );
      });

      it('el aviso queda en la bandeja como Message OUT', async () => {
        // Sin esto, la recepcionista abre el hilo, ve la nota de voz y nada
        // más: no sabe que el bot ya le dijo al paciente que iba a pasarle con
        // una persona, y le escribe como si nadie le hubiera contestado.
        stt.transcribe.mockRejectedValue(new MediaExpiredError());

        await processor(audioJob());

        expect(prisma.message.create).toHaveBeenCalledWith({
          data: {
            conversationId: 'convo-1',
            direction: 'OUT',
            body: expect.stringContaining('No pude escuchar'),
          },
        });
      });

      it('si el envío falla, NO se escribe el OUT: la bandeja no miente', async () => {
        stt.transcribe.mockRejectedValue(new MediaExpiredError());
        waha.sendText.mockRejectedValue(new Error('waha down'));

        await processor(audioJob());

        expect(prisma.message.create).not.toHaveBeenCalled();
      });

      it('si el aviso no sale, la derivación se mantiene', async () => {
        stt.transcribe.mockRejectedValue(new MediaExpiredError());
        waha.sendText.mockRejectedValue(new Error('waha down'));

        await expect(processor(audioJob())).resolves.toBeUndefined();
        expect(prisma.conversation.updateMany).toHaveBeenCalled();
      });
    });
  });
});
