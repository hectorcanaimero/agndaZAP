import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { BotService } from '../bot/bot.service';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from './waha.service';
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

  let prisma: {
    clinic: { findUnique: jest.Mock; update: jest.Mock };
    conversation: { upsert: jest.Mock };
    message: { create: jest.Mock };
  };
  let bot: { handleIncoming: jest.Mock };
  let redis: jest.Mocked<Pick<Redis, 'set' | 'del' | 'incr' | 'expire'>>;
  let waha: { sendText: jest.Mock };
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

  /** Mensaje con adjunto (B4): `type` fuera de {chat,text} y/o `hasMedia`. */
  function mediaEvent(
    payload: Record<string, unknown>,
    id: string | undefined = MSG_ID,
  ): WahaWebhookBody {
    return {
      event: 'message',
      session: 'clinic-a',
      payload: {
        ...(id ? { id } : {}),
        from: FROM,
        fromMe: false,
        body: '',
        ...payload,
      },
    };
  }

  /** El aviso de media usa su propia clave; el dedup usa `waha:evt:`. */
  function throttleExhausted() {
    redis.set.mockImplementation(async (key: unknown) =>
      String(key).startsWith('bot:media-notice:') ? null : 'OK',
    );
  }

  const NOTICE_TEXT =
    'Por ahora solo puedo leer mensajes de texto. ¿Me escribes lo que necesitas?';

  async function post(body: WahaWebhookBody) {
    return controller.handleWaha(body, { rawBody: undefined }, TOKEN, undefined);
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_TOKEN = TOKEN;
    delete process.env.WEBHOOK_HMAC_SECRET;

    prisma = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'clinic-A',
          status: 'ACTIVE',
          wahaSession: 'clinic-a',
        }),
        update: jest.fn(),
      },
      conversation: {
        upsert: jest.fn().mockResolvedValue({ id: 'convo-1', state: 'BOT' }),
      },
      message: { create: jest.fn().mockResolvedValue({ id: 'msg-1' }) },
    };
    bot = { handleIncoming: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      // Rate-limit del ADR 0007: por defecto siempre dentro de la cota.
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<
      Pick<Redis, 'set' | 'del' | 'incr' | 'expire'>
    >;
    waha = { sendText: jest.fn().mockResolvedValue(undefined) };
    controller = new WebhookController(
      prisma as unknown as PrismaService,
      bot as unknown as BotService,
      redis as unknown as Redis,
      waha as unknown as WahaService,
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

  it('clínica SUSPENDED: message → { ok: true } sin llamar al bot ni marcar dedup', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce({ id: 'clinic-A', status: 'SUSPENDED' });
    const result = await post(messageEvent(MSG_ID));
    expect(result).toEqual({ ok: true });
    expect(bot.handleIncoming).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('clínica SUSPENDED: session.status se sigue procesando', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce({ id: 'clinic-A', status: 'SUSPENDED' });
    await post({ event: 'session.status', session: 'clinic-a', payload: { status: 'WORKING' } });
    expect(prisma.clinic.update).toHaveBeenCalledWith({
      where: { id: 'clinic-A' },
      data: { wahaConnected: true },
    });
  });

  it('session desconocida → { ok: true } sin procesar', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce(null);
    await post(messageEvent('msg-5'));
    expect(bot.handleIncoming).not.toHaveBeenCalled();
  });

  /**
   * B4: los mensajes sin texto (audio, imagen, sticker, ubicación, documento)
   * no llegan al bot. Se registran en la bandeja y se responde una sola vez
   * cada 6 h explicando que sólo leemos texto.
   */
  describe('mensajes sin texto (B4)', () => {
    it('audio: no llama al bot, registra [audio] y responde una vez', async () => {
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));

      expect(bot.handleIncoming).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clinicId_chatId: { clinicId: 'clinic-A', chatId: FROM } },
          create: expect.objectContaining({
            clinicId: 'clinic-A',
            chatId: FROM,
            phone: `+${PHONE}`,
            state: 'BOT',
          }),
        }),
      );
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'IN', body: '[audio]' },
      });
      expect(waha.sendText).toHaveBeenCalledWith('clinic-a', FROM, NOTICE_TEXT);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'OUT', body: NOTICE_TEXT },
      });
    });

    it('throttle: SET NX EX 21600 sobre bot:media-notice:{clinicId}:{chatId}', async () => {
      await post(mediaEvent({ type: 'image', hasMedia: true }));
      expect(redis.set).toHaveBeenCalledWith(
        `bot:media-notice:clinic-A:${FROM}`,
        '1',
        'EX',
        21_600,
        'NX',
      );
    });

    it('segundo audio dentro de la ventana: registra pero NO responde', async () => {
      throttleExhausted();
      await post(mediaEvent({ type: 'ptt', hasMedia: true }, 'otro-id'));

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'IN', body: '[audio]' },
      });
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('Redis caído en el throttle → fail-closed: registra y no responde', async () => {
      redis.set.mockImplementation(async (key: unknown) => {
        if (String(key).startsWith('bot:media-notice:')) {
          throw new Error('redis down');
        }
        return 'OK';
      });
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('conversación tomada por un humano: registra y se queda callado', async () => {
      prisma.conversation.upsert.mockResolvedValueOnce({
        id: 'convo-1',
        state: 'HUMAN',
      });
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'IN', body: '[audio]' },
      });
      expect(waha.sendText).not.toHaveBeenCalled();
      // No gasta el throttle: la próxima vez que el bot tenga la conversación
      // sí puede avisar.
      expect(redis.set).not.toHaveBeenCalledWith(
        expect.stringContaining('bot:media-notice:'),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('imagen con pie de foto: conserva el texto detrás de la etiqueta', async () => {
      await post(
        mediaEvent({ type: 'image', hasMedia: true, body: 'quiero una cita' }),
      );
      expect(bot.handleIncoming).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: 'convo-1',
          direction: 'IN',
          body: '[imagen] quiero una cita',
        },
      });
    });

    it.each([
      ['ptt', '[audio]'],
      ['audio', '[audio]'],
      ['image', '[imagen]'],
      ['video', '[video]'],
      ['sticker', '[sticker]'],
      ['location', '[ubicación]'],
      ['document', '[archivo]'],
      ['vcard', '[contacto]'],
    ])('type=%s queda en la bandeja como %s', async (type, label) => {
      await post(mediaEvent({ type, hasMedia: true }));
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'IN', body: label },
      });
    });

    it('tipo desconocido con hasMedia → [archivo]', async () => {
      await post(mediaEvent({ type: 'algo_nuevo_de_waha', hasMedia: true }));
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'IN', body: '[archivo]' },
      });
    });

    it('body vacío sin type ni hasMedia → [mensaje sin texto], sin bot', async () => {
      await post(mediaEvent({ body: '   ' }));
      expect(bot.handleIncoming).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          conversationId: 'convo-1',
          direction: 'IN',
          body: '[mensaje sin texto]',
        },
      });
    });

    it('el type puede venir dentro de _data', async () => {
      await post(mediaEvent({ _data: { type: 'ptt' } }));
      expect(bot.handleIncoming).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: { conversationId: 'convo-1', direction: 'IN', body: '[audio]' },
      });
    });

    it('texto normal sigue igual: va al bot y no registra ni responde aquí', async () => {
      await post(messageEvent(MSG_ID));
      expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('type=chat explícito sigue yendo al bot', async () => {
      await post(mediaEvent({ type: 'chat', body: 'hola', hasMedia: false }));
      expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('clínica SUSPENDED: ni registra ni responde al audio', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({
        id: 'clinic-A',
        status: 'SUSPENDED',
        wahaSession: 'clinic-a',
      });
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(waha.sendText).not.toHaveBeenCalled();
    });

    it('si el registro falla libera el dedup y relanza (WAHA reintenta)', async () => {
      prisma.conversation.upsert.mockRejectedValueOnce(new Error('db down'));
      await expect(
        post(mediaEvent({ type: 'ptt', hasMedia: true })),
      ).rejects.toThrow('db down');
      expect(redis.del).toHaveBeenCalledWith(expectedKey(FROM, MSG_ID));
    });

    it('el mismo adjunto entregado dos veces deja una sola fila y un solo aviso', async () => {
      redis.set.mockImplementation(async (key: unknown) =>
        String(key).startsWith('waha:evt:')
          ? (redis.set.mock.calls.filter((c) =>
              String(c[0]).startsWith('waha:evt:'),
            ).length > 1
              ? null
              : 'OK')
          : 'OK',
      );
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));

      expect(
        prisma.message.create.mock.calls.filter(
          (c) => c[0].data.direction === 'IN',
        ),
      ).toHaveLength(1);
      expect(waha.sendText).toHaveBeenCalledTimes(1);
    });

    describe('rate-limit del ADR 0007 (el camino nuevo no pasa por el bot)', () => {
      it('usa las mismas claves de Redis que BotService, para compartir cota', async () => {
        await post(mediaEvent({ type: 'ptt', hasMedia: true }));
        expect(redis.incr).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(`^bot:msg:clinic-A:${FROM.replace('.', '\\.')}:\\d+$`),
          ),
        );
        expect(redis.incr).toHaveBeenCalledWith(
          expect.stringMatching(/^bot:msg:clinic-A:hour:\d+$/),
        );
      });

      it('pasado el tope por chat no escribe en la bandeja ni responde', async () => {
        redis.incr.mockResolvedValueOnce(16);
        await post(mediaEvent({ type: 'ptt', hasMedia: true }));

        expect(prisma.conversation.upsert).not.toHaveBeenCalled();
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(waha.sendText).not.toHaveBeenCalled();
      });

      it('abierto el circuit breaker por clínica tampoco escribe ni responde', async () => {
        redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(501);
        await post(mediaEvent({ type: 'ptt', hasMedia: true }));

        expect(prisma.conversation.upsert).not.toHaveBeenCalled();
        expect(waha.sendText).not.toHaveBeenCalled();
      });

      it('el log del tope no filtra el teléfono', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn');
        redis.incr.mockResolvedValueOnce(16);
        await post(mediaEvent({ type: 'ptt', hasMedia: true }));
        for (const call of warnSpy.mock.calls) {
          expect(String(call[0])).not.toContain(PHONE);
        }
      });

      it('Redis caído en el rate-limit → fail-open, se registra igual', async () => {
        redis.incr.mockRejectedValueOnce(new Error('redis down'));
        await post(mediaEvent({ type: 'ptt', hasMedia: true }));
        expect(prisma.conversation.upsert).toHaveBeenCalled();
      });
    });

    describe('payload hostil y tipos raros', () => {
      // `type` lo controla quien manda el evento. Con acceso directo al object
      // literal, `constructor` devolvía una función de Object.prototype que
      // acababa en el campo String de Prisma → 500 → reintento infinito.
      it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
        'type=%s no saca nada de Object.prototype',
        async (type) => {
          await post(mediaEvent({ type, hasMedia: true }));
          const inCall = prisma.message.create.mock.calls.find(
            (c) => c[0].data.direction === 'IN',
          );
          expect(typeof inCall?.[0].data.body).toBe('string');
          expect(inCall?.[0].data.body).toBe('[archivo]');
        },
      );

      it('type=chat con hasMedia pero con texto: va al bot, no se traga el mensaje', async () => {
        await post(
          mediaEvent({ type: 'chat', hasMedia: true, body: 'quiero cita el martes' }),
        );
        expect(bot.handleIncoming).toHaveBeenCalledTimes(1);
        expect(waha.sendText).not.toHaveBeenCalled();
      });

      it.each(['reaction', 'e2e_notification', 'protocol', 'ciphertext', 'revoked'])(
        'type=%s se ignora del todo: ni bandeja ni respuesta',
        async (type) => {
          await post(mediaEvent({ type }));
          expect(prisma.conversation.upsert).not.toHaveBeenCalled();
          expect(waha.sendText).not.toHaveBeenCalled();
          expect(bot.handleIncoming).not.toHaveBeenCalled();
        },
      );

      it.each([
        '120363000000000000@g.us',
        'status@broadcast',
        '123@broadcast',
      ])('%s (grupo/estado) no recibe respuesta ni fila', async (from) => {
        await post({
          event: 'message',
          session: 'clinic-a',
          payload: { id: 'g-1', from, fromMe: false, body: '', type: 'sticker', hasMedia: true },
        });
        expect(prisma.conversation.upsert).not.toHaveBeenCalled();
        expect(waha.sendText).not.toHaveBeenCalled();
      });

      it('fromMe con adjunto: no registra nada', async () => {
        await post(mediaEvent({ type: 'ptt', hasMedia: true, fromMe: true }));
        expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      });

      it('pie de foto larguísimo: se trunca a 500 caracteres', async () => {
        await post(
          mediaEvent({ type: 'image', hasMedia: true, body: 'a'.repeat(900) }),
        );
        const inCall = prisma.message.create.mock.calls.find(
          (c) => c[0].data.direction === 'IN',
        );
        expect(inCall?.[0].data.body).toBe(`[imagen] ${'a'.repeat(500)}`);
      });
    });

    it('con pie de foto el aviso reconoce que el paciente sí escribió', async () => {
      await post(mediaEvent({ type: 'image', hasMedia: true, body: 'hola' }));
      expect(waha.sendText).toHaveBeenCalledWith(
        'clinic-a',
        FROM,
        'No puedo abrir lo que me mandaste, pero sí leo tus mensajes. ¿Me cuentas por aquí qué necesitas?',
      );
    });

    it('si sendText falla: no relanza, libera el throttle y no duplica la bandeja', async () => {
      waha.sendText.mockRejectedValueOnce(new Error('waha down'));
      const result = await post(mediaEvent({ type: 'ptt', hasMedia: true }));

      expect(result).toEqual({ ok: true });
      // No se libera el dedup: el registro sí se completó.
      expect(redis.del).not.toHaveBeenCalledWith(expectedKey(FROM, MSG_ID));
      // Sí se libera el throttle, para poder avisar en el próximo adjunto.
      expect(redis.del).toHaveBeenCalledWith(
        `bot:media-notice:clinic-A:${FROM}`,
      );
      expect(
        prisma.message.create.mock.calls.filter(
          (c) => c[0].data.direction === 'IN',
        ),
      ).toHaveLength(1);
    });

    it('dos clínicas con el mismo chatId no comparten conversación ni throttle', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce({
        id: 'clinic-B',
        status: 'ACTIVE',
        wahaSession: 'clinic-b',
      });
      await post(mediaEvent({ type: 'ptt', hasMedia: true }));

      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clinicId_chatId: { clinicId: 'clinic-B', chatId: FROM } },
        }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        `bot:media-notice:clinic-B:${FROM}`,
        '1',
        'EX',
        21_600,
        'NX',
      );
      expect(waha.sendText).toHaveBeenCalledWith(
        'clinic-b',
        FROM,
        expect.any(String),
      );
    });
  });
});
