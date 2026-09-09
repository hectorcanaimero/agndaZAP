import { BotService } from '../bot/bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookController } from './webhook.controller';

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
  let redis: { set: jest.Mock };
  let controller: WebhookController;

  function messageEvent(id: string | undefined, from = '584141234567@c.us') {
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

  async function post(body: unknown) {
    return controller.handleWaha(
      body as any,
      { rawBody: undefined },
      TOKEN,
      undefined,
    );
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
    redis = { set: jest.fn().mockResolvedValue('OK') };
    controller = new WebhookController(
      prisma as unknown as PrismaService,
      bot as unknown as BotService,
      redis as any,
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('primer evento con id: marca en Redis (SET NX EX 86400) y procesa', async () => {
    await post(messageEvent('msg-1'));
    expect(redis.set).toHaveBeenCalledWith(
      'waha:evt:clinic-a:msg-1',
      '1',
      'EX',
      86_400,
      'NX',
    );
    expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
  });

  it('segundo evento con el mismo id NO llama a bot.handleIncoming', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await post(messageEvent('msg-1'));
    const result = await post(messageEvent('msg-1'));
    expect(result).toEqual({ ok: true });
    expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
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
