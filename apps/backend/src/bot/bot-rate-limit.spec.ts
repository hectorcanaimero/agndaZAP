import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  BOT_PER_CHAT_LIMIT,
  BOT_PER_CLINIC_HOURLY_LIMIT,
  botRateLimitKeys,
  hashChatId,
  withinBotRateLimit,
} from './bot-rate-limit';

describe('bot-rate-limit (ADR 0007)', () => {
  let counters: Map<string, number>;
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let logger: { warn: jest.Mock; error: jest.Mock };

  const clinicId = 'clinic-A';
  const chatId = '5804141234567@c.us';

  beforeEach(() => {
    counters = new Map();
    redis = {
      incr: jest.fn(async (key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }),
      expire: jest.fn().mockResolvedValue(1),
    };
    logger = { warn: jest.fn(), error: jest.fn() };
  });

  const call = (scope: 'bot' | 'media' = 'bot') =>
    withinBotRateLimit(redis as unknown as Redis, logger as unknown as Logger, {
      clinicId,
      chatId,
      scope,
    });

  it('deja pasar hasta el cap por conversación y descarta el siguiente', async () => {
    for (let i = 0; i < BOT_PER_CHAT_LIMIT; i++) {
      await expect(call()).resolves.toBe(true);
    }
    await expect(call()).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('pone TTL solo en el primer incr de cada ventana', async () => {
    await call();
    await call();

    const { chatKey, clinicKey } = botRateLimitKeys(clinicId, chatId, Date.now());
    expect(redis.expire).toHaveBeenCalledWith(chatKey, 90);
    expect(redis.expire).toHaveBeenCalledWith(clinicKey, 3900);
    expect(redis.expire).toHaveBeenCalledTimes(2); // no se renueva en el 2º
  });

  it('abre el circuito por clínica al superar el cap horario', async () => {
    // Saturamos la ventana horaria sin tocar la del chat: un chatId por vuelta.
    const { clinicKey } = botRateLimitKeys(clinicId, chatId, Date.now());
    counters.set(clinicKey, BOT_PER_CLINIC_HOURLY_LIMIT);

    await expect(call()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('circuit OPEN'),
    );
  });

  it('los dos scopes comparten claves y presupuesto: un mensaje se cuenta una vez', async () => {
    for (let i = 0; i < BOT_PER_CHAT_LIMIT; i++) {
      await expect(i % 2 === 0 ? call('bot') : call('media')).resolves.toBe(true);
    }
    // El 16º, venga por donde venga, ya no pasa.
    await expect(call('media')).resolves.toBe(false);

    const { chatKey } = botRateLimitKeys(clinicId, chatId, Date.now());
    expect(counters.get(chatKey)).toBe(BOT_PER_CHAT_LIMIT + 1);
  });

  it('el scope solo etiqueta el log, no cambia el comportamiento', async () => {
    counters.set(botRateLimitKeys(clinicId, chatId, Date.now()).chatKey, BOT_PER_CHAT_LIMIT);

    await call('media');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^media rate-limit /),
    );
  });

  it('fail-open si Redis está caído', async () => {
    redis.incr.mockRejectedValue(new Error('redis down'));

    await expect(call()).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('redis down'),
    );
  });

  it('los logs no llevan el chatId en claro', async () => {
    counters.set(botRateLimitKeys(clinicId, chatId, Date.now()).chatKey, BOT_PER_CHAT_LIMIT);

    await call();

    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).not.toContain('5804141234567');
    expect(line).toContain(hashChatId(chatId));
    expect(hashChatId(chatId)).toHaveLength(12);
  });

  it('las claves son las del ADR 0007 y no cambiaron', () => {
    const now = Date.parse('2026-09-11T15:30:45.000Z');
    expect(botRateLimitKeys(clinicId, chatId, now)).toEqual({
      chatKey: `bot:msg:clinic-A:${chatId}:${Math.floor(now / 60000)}`,
      clinicKey: `bot:msg:clinic-A:hour:${Math.floor(now / 3600000)}`,
    });
  });
});
