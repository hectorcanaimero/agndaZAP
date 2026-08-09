import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { ConversationsController } from './conversations.controller';
import { ReplyDto } from './dto/reply.dto';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('ReplyDto sanitization', () => {
  it('elimina control chars ASCII (defensa contra payloads raros)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const out = (await pipe.transform(
      { text: 'hola\x00\x01\x1F<script>' },
      { type: 'body', metatype: ReplyDto },
    )) as ReplyDto;
    // \x00-\x1F removidos. `<script>` no lo removemos porque el escape es
    // responsabilidad del render en el frontend; acá solo blindamos control chars.
    expect(out.text).toBe('hola<script>');
  });

  it('preserva \\n y \\t (mensajes multilínea legítimos)', async () => {
    const dto = plainToInstance(ReplyDto, { text: 'linea1\nlinea2\ttab' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.text).toBe('linea1\nlinea2\ttab');
  });

  it('rechaza text > 1500 chars', async () => {
    const long = 'a'.repeat(1501);
    const dto = plainToInstance(ReplyDto, { text: long });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ConversationsController', () => {
  let prisma: Deep<PrismaService>;
  let waha: Deep<WahaService>;
  let controller: ConversationsController;

  const adminA: AuthUser = {
    userId: 'u',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  beforeEach(() => {
    prisma = {
      conversation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'c-1',
            chatId: '58414@c.us',
            phone: '+58414',
            state: 'BOT',
            updatedAt: new Date(),
            createdAt: new Date(),
            _count: { messages: 3 },
            messages: [
              {
                id: 'm-1',
                direction: 'IN',
                body: 'hola',
                createdAt: new Date(),
              },
            ],
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'c-1',
          clinicId: 'clinic-A',
          chatId: '58414@c.us',
          state: 'BOT',
          clinic: { wahaSession: 'demo-session' },
          messages: [],
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'c-1', ...data }),
        ),
      },
      message: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'm-new',
            ...data,
            createdAt: new Date(),
          }),
        ),
      },
    };
    waha = {
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    controller = new ConversationsController(
      prisma as unknown as PrismaService,
      waha as unknown as WahaService,
    );
  });

  it('list → multi-tenant + estado agregado (lastMessage, messageCount)', async () => {
    const rows = await controller.list(adminA);
    const call = prisma.conversation.findMany.mock.calls[0][0];
    expect(call.where.clinicId).toBe('clinic-A');
    expect(rows[0].lastMessage).toBeDefined();
    expect(rows[0].messageCount).toBe(3);
  });

  it('list → filtro por state=HUMAN', async () => {
    await controller.list(adminA, 'HUMAN');
    const call = prisma.conversation.findMany.mock.calls[0][0];
    expect(call.where.state).toBe('HUMAN');
  });

  it('list → state inválido tira 400', async () => {
    await expect(controller.list(adminA, 'INVALID')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('takeover → set state=HUMAN', async () => {
    await controller.takeover(adminA, 'c-1');
    const call = prisma.conversation.update.mock.calls[0][0];
    expect(call.data.state).toBe('HUMAN');
  });

  it('takeover → 404 cross-tenant', async () => {
    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.takeover(adminA, 'c-of-B'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reply → envía por WAHA, guarda Message OUT, bump updatedAt', async () => {
    await controller.reply(adminA, 'c-1', { text: 'hola paciente' });
    expect(waha.sendText).toHaveBeenCalledWith(
      'demo-session',
      '58414@c.us',
      'hola paciente',
    );
    const msgCall = prisma.message.create.mock.calls[0][0];
    expect(msgCall.data.direction).toBe('OUT');
    expect(msgCall.data.body).toBe('hola paciente');
  });

  it('reply → si WAHA falla, NO guarda el mensaje y responde 400', async () => {
    waha.sendText.mockRejectedValueOnce(new Error('waha down'));
    await expect(
      controller.reply(adminA, 'c-1', { text: 'hola' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('release → set state=BOT, limpia flowStep y flowData', async () => {
    await controller.release(adminA, 'c-1');
    const call = prisma.conversation.update.mock.calls[0][0];
    expect(call.data.state).toBe('BOT');
    expect(call.data.flowStep).toBeNull();
    // flowData debe ser Prisma.JsonNull para que se guarde como NULL en Postgres.
    expect(call.data.flowData).toBe(Prisma.JsonNull);
  });
});
