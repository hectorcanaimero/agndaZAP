import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { DateTime } from 'luxon';
import { Intent } from './intent.service';
import { BOT_STATS_TTL_S, botStatsKey, recordBotStats } from './bot-stats';
import type { BotTurnEvent } from './bot-turn-event';

/**
 * Contadores agregados por clínica y día (M9). Son la fuente del dashboard,
 * así que lo que importa es que no se escriban campos arbitrarios, que caduquen
 * solos y que no puedan tumbar un turno.
 */
describe('bot-stats', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ops: any[];
  let redis: Pick<Redis, 'pipeline'>;
  const logger = new Logger('test');

  function baseEvent(over: Partial<BotTurnEvent> = {}): BotTurnEvent {
    return {
      event: 'bot.turn',
      clinicId: 'clinic-A',
      chatHash: 'abc123def456',
      outcome: 'ok',
      latencyMs: 120,
      ...over,
    };
  }

  function fields(): string[] {
    return ops.filter((o) => o[0] === 'hincrby').map((o) => o[2]);
  }

  beforeEach(() => {
    ops = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      exec: jest.fn().mockResolvedValue([]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain.hincrby = jest.fn((...a: any[]) => {
      ops.push(['hincrby', ...a]);
      return chain;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain.expire = jest.fn((...a: any[]) => {
      ops.push(['expire', ...a]);
      return chain;
    });
    redis = { pipeline: jest.fn(() => chain) } as unknown as Pick<
      Redis,
      'pipeline'
    >;
  });

  afterEach(() => jest.restoreAllMocks());

  it('la clave es por clínica y día', () => {
    const key = botStatsKey(
      'clinic-A',
      'UTC',
      DateTime.fromISO('2026-09-11T23:30:00Z', { zone: 'utc' }),
    );
    expect(key).toBe('bot:stats:clinic-A:2026-09-11');
  });

  /**
   * Con corte UTC, en Caracas (UTC-4) todo lo que entra de 20:00 a medianoche
   * caería en el día siguiente y el "hoy" del panel saldría a cero justo en la
   * franja de tarde-noche.
   */
  it('el día es el de la clínica, no el de UTC', () => {
    const at = DateTime.fromISO('2026-09-12T01:30:00Z', { zone: 'utc' });
    expect(botStatsKey('clinic-A', 'America/Caracas', at)).toBe(
      'bot:stats:clinic-A:2026-09-11',
    );
    expect(botStatsKey('clinic-A', 'UTC', at)).toBe(
      'bot:stats:clinic-A:2026-09-12',
    );
  });

  it('el clinicId de la clave va acotado: es lo que separa un tenant de otro', () => {
    expect(botStatsKey('clinic-A:evil*', 'UTC')).toContain('bot:stats:clinic-Aevil:');
  });

  it('avisa si el pipeline falla a medias, en vez de contar ceros en silencio', async () => {
    const chain: any = {
      hincrby: jest.fn(() => chain),
      expire: jest.fn(() => chain),
      exec: jest.fn().mockResolvedValue([[new Error('WRONGTYPE'), null]]),
    };
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    await recordBotStats(
      { pipeline: () => chain } as unknown as Redis,
      logger,
      baseEvent(),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fallaron'));
  });

  it('cuenta el turno y su desenlace', async () => {
    await recordBotStats(redis as Redis, logger, baseEvent());
    expect(fields()).toEqual(['turns', 'outcome:ok']);
  });

  it('desglosa intención, origen y handoff', async () => {
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({ intent: Intent.AGENDAR, source: 'llm', handoff: true }),
    );
    expect(fields()).toEqual(
      expect.arrayContaining(['intent:agendar', 'source:llm', 'handoff']),
    );
  });

  it('handoff falso no suma: si no, la tasa saldría siempre al 100%', async () => {
    await recordBotStats(redis as Redis, logger, baseEvent({ handoff: false }));
    expect(fields()).not.toContain('handoff');
  });

  it('del RAG cuenta búsquedas, aciertos y NULL_ANSWER por separado', async () => {
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({
        rag: { candidates: 5, matches: 2, minDist: 0.31, nullAnswer: false },
      }),
    );
    expect(fields()).toEqual(expect.arrayContaining(['rag', 'ragMatched']));
    expect(fields()).not.toContain('nullAnswer');

    ops = [];
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({
        rag: { candidates: 5, matches: 0, minDist: null, nullAnswer: true },
      }),
    );
    expect(fields()).toEqual(expect.arrayContaining(['rag', 'nullAnswer']));
    expect(fields()).not.toContain('ragMatched');
  });

  /**
   * `intent` viaja desde el clasificador. Hoy sale de un enum, pero no quiero
   * que una respuesta rara del LLM escriba campos arbitrarios en Redis.
   */
  it('sanea el nombre del campo derivado de un valor', async () => {
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({ intent: 'Agendar; FLUSHALL\n:x' as Intent }),
    );
    expect(fields()).toContain('intent:agendarflushallx');
  });

  it('acota la longitud del campo', async () => {
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({ intent: 'a'.repeat(200) as Intent }),
    );
    const intent = fields().find((f) => f.startsWith('intent:'))!;
    expect(intent.length).toBe('intent:'.length + 40);
  });

  it('un valor que se queda en nada no escribe campo', async () => {
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({ intent: ';;;' as Intent }),
    );
    expect(fields().some((f) => f.startsWith('intent:'))).toBe(false);
  });

  it('la clave caduca sola: son métricas, no datos que guardar', async () => {
    await recordBotStats(redis as Redis, logger, baseEvent());
    const expire = ops.find((o) => o[0] === 'expire');
    expect(expire[2]).toBe(BOT_STATS_TTL_S);
    // `NX`: el TTL se fija al crear la clave, no se renueva en cada turno.
    expect(expire[3]).toBe('NX');
    expect(BOT_STATS_TTL_S).toBeGreaterThan(30 * 86_400);
  });

  it('Redis caído no propaga: perder una métrica no puede costar una respuesta', async () => {
    const broken = {
      pipeline: () => {
        throw new Error('redis down');
      },
    } as unknown as Redis;

    await expect(
      recordBotStats(broken, logger, baseEvent()),
    ).resolves.toBeUndefined();
  });

  it('no escribe nada del paciente', async () => {
    await recordBotStats(
      redis as Redis,
      logger,
      baseEvent({ intent: Intent.AGENDAR }),
    );
    const dump = JSON.stringify(ops);
    expect(dump).not.toContain('584141234567');
    expect(dump).toContain('clinic-A');
  });
});
