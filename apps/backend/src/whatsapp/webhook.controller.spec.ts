import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { BotService } from '../bot/bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { WahaWebhookBody, WebhookController } from './webhook.controller';

/**
 * Tests del WebhookController: dedup de eventos por `payload.id` (WAHA
 * reintenta y puede entregar el mismo mensaje dos veces) + normalización del
 * phone a E.164 con `+`.
 *
 * Mocks manuales (prisma/bot/redis). Auth por WEBHOOK_TOKEN en env.
 */
describe('WebhookController', () => {
  const TOKEN = 'test-webhook-token';
  const originalEnv = { ...process.env };

  let prisma: { clinic: { findUnique: jest.Mock; update: jest.Mock } };
  let bot: { handleIncoming: jest.Mock };
  let redis: jest.Mocked<Pick<Redis, 'set' | 'del'>>;
  let controller: WebhookController;

  const PHONE = '584141234567';
  const FROM = `${PHONE}@c.us`;
  // Forma real de los ids de WAHA: contienen el teléfono.
  const MSG_ID = `false_${FROM}_3EB0ABCDEF`;

  function expectedKey(from: string, id: string) {
    const digest = createHash('sha256').update(`${from}|${id}`).digest('hex');
    return `waha:evt:clinic-a:${digest}`;
  }

  function messageEvent(
    id: string | undefined,
    from = FROM,
  ): WahaWebhookBody {
    return {
      event: 'message',
      session: 'clinic-a',
      payload: {
        ...(id ? { id } : {}),
        from,
        body: 'hola',
        fromMe: false,
      },
    };
  }

  async function post(body: WahaWebhookBody) {
    return controller.handleWaha(body, { rawBody: undefined }, TOKEN, undefined);
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_TOKEN = TOKEN;
    delete process.env.WEBHOOK_HMAC_SECRET;

    prisma = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue({ id: 'clinic-A' }),
        update: jest.fn(),
      },
    };
    bot = { handleIncoming: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<Pick<Redis, 'set' | 'del'>>;
    controller = new WebhookController(
      prisma as unknown as PrismaService,
      bot as unknown as BotService,
      redis as unknown as Redis,
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('primer evento con id: marca en Redis (SET NX EX 86400) con clave hasheada y procesa', async () => {
    await post(messageEvent(MSG_ID));
    expect(redis.set).toHaveBeenCalledWith(
      expectedKey(FROM, MSG_ID),
      '1',
      'EX',
      86_400,
      'NX',
    );
    // La clave NO contiene el teléfono ni el id crudo.
    const key = redis.set.mock.calls[0][0] as string;
    expect(key).not.toContain(PHONE);
    expect(key).not.toContain('3EB0ABCDEF');
    expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
  });

  it('segundo evento con el mismo id NO llama a bot.handleIncoming y no loguea PHI', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug');
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await post(messageEvent(MSG_ID));
    const result = await post(messageEvent(MSG_ID));
    expect(result).toEqual({ ok: true });
    expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
    for (const call of debugSpy.mock.calls) {
      const msg = String(call[0]);
      expect(msg).not.toContain(PHONE);
      expect(msg).not.toContain(MSG_ID);
    }
  });

  it('bot lanza → libera la clave y relanza; el reintento sí se procesa', async () => {
    bot.handleIncoming.mockRejectedValueOnce(new Error('bot down'));
    await expect(post(messageEvent(MSG_ID))).rejects.toThrow('bot down');
    expect(redis.del).toHaveBeenCalledWith(expectedKey(FROM, MSG_ID));

    // Reintento de WAHA: la clave ya no existe → SET NX vuelve a dar OK.
    await post(messageEvent(MSG_ID));
    expect(bot.handleIncoming).toHaveBeenCalledTimes(2);
  });

  it('bot lanza y Redis falla el DEL → igual relanza (best-effort)', async () => {
    bot.handleIncoming.mockRejectedValueOnce(new Error('bot down'));
    redis.del.mockRejectedValueOnce(new Error('redis down'));
    await expect(post(messageEvent(MSG_ID))).rejects.toThrow('bot down');
  });

  it('sin payload.id procesa normal y no toca Redis', async () => {
    await post(messageEvent(undefined));
    expect(redis.set).not.toHaveBeenCalled();
    expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
  });

  it('Redis lanza → fail-open: procesa igual', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    await post(messageEvent('msg-2'));
    expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
  });

  it('normaliza el phone de <phone>@c.us a E.164 con "+"', async () => {
    await post(messageEvent('msg-3', '584141234567@c.us'));
    expect(bot.handleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: 'clinic-A',
        chatId: '584141234567@c.us',
        phone: '+584141234567',
        lid: null,
      }),
    );
  });

  it('@lid: phone null y lid con el id pelado', async () => {
    await post(messageEvent('msg-4', '123456789012345@lid'));
    expect(bot.handleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ phone: null, lid: '123456789012345' }),
    );
  });

  it('session desconocida → { ok: true } sin procesar', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce(null);
    await post(messageEvent('msg-5'));
    expect(bot.handleIncoming).not.toHaveBeenCalled();
  });
});
