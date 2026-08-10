import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConversationState, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from '../whatsapp/waha.service';
import { ReplyDto } from './dto/reply.dto';

/**
 * Controller de conversaciones (bandeja del panel).
 *
 * Reglas duras:
 * - Multi-tenant vía `tenantWhere`.
 * - Cero PII en logs: sólo convoId + slug/clinicId + count.
 * - `reply` sanitiza el body (ver `ReplyDto`) y envía por WAHA.
 * - `release` limpia `flowStep`/`flowData` para que la próxima interacción
 *   del bot arranque limpia (evita re-usar estado obsoleto de FSM).
 */
@Controller('conversations')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class ConversationsController {
  private readonly logger = new Logger('ConversationsController');

  constructor(
    private readonly prisma: PrismaService,
    private readonly waha: WahaService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('state') state?: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    let stateFilter: ConversationState | undefined;
    if (state) {
      if (
        state !== 'BOT' &&
        state !== 'NEEDS_HUMAN' &&
        state !== 'HUMAN'
      ) {
        throw new BadRequestException('state inválido');
      }
      stateFilter = state as ConversationState;
    }
    const where: Prisma.ConversationWhereInput = {
      ...tenantWhere(user, clinicIdOverride),
      ...(stateFilter ? { state: stateFilter } : {}),
    };
    const convos = await this.prisma.conversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        chatId: true,
        phone: true,
        lid: true,
        contactName: true,
        avatarUrl: true,
        state: true,
        updatedAt: true,
        createdAt: true,
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            direction: true,
            body: true,
            createdAt: true,
          },
        },
      },
    });
    // Aplanamos `messages[0]` → `lastMessage` para no confundir al frontend.
    return convos.map((c) => ({
      id: c.id,
      chatId: c.chatId,
      phone: c.phone,
      lid: c.lid,
      contactName: c.contactName,
      avatarUrl: c.avatarUrl,
      state: c.state,
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      messageCount: c._count.messages,
      lastMessage: c.messages[0] ?? null,
    }));
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limitRaw?: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitRaw ?? '50')));
    const convo = await this.prisma.conversation.findFirst({
      where: { id, ...tenantWhere(user, clinicIdOverride) },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: limit,
        },
        // Necesario para `messageCount` en el header del chat — sin esto el
        // frontend renderiza "NaN mensajes" (t('messagesCount', { n: undefined })).
        _count: { select: { messages: true } },
      },
    });
    if (!convo) throw new NotFoundException('conversación no encontrada');
    // Devolvemos los mensajes en orden cronológico ascendente (el .desc + take
    // arriba fue solo para tomar los últimos N).
    const { _count, ...rest } = convo;
    return {
      ...rest,
      messageCount: _count.messages,
      messages: [...convo.messages].reverse(),
    };
  }

  @Post(':id/takeover')
  @HttpCode(200)
  async takeover(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.conversation.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('conversación no encontrada');

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { state: ConversationState.HUMAN },
      select: { id: true, state: true },
    });
    this.logger.log(`convo takeover convoId=${id} by=${user.userId}`);
    return updated;
  }

  @Post(':id/reply')
  @HttpCode(200)
  async reply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReplyDto,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const convo = await this.prisma.conversation.findFirst({
      where: { id, clinicId: scope.clinicId },
      include: { clinic: { select: { wahaSession: true } } },
    });
    if (!convo) throw new NotFoundException('conversación no encontrada');

    // Validación: si el texto queda vacío después de la sanitización, 400.
    // (class-validator ya chequea @MinLength(1), pero el @Transform corre
    // antes, así que si el input era todo control chars ahora es '').
    if (!dto.text || dto.text.length === 0) {
      throw new BadRequestException('text vacío tras sanitización');
    }

    // Envío por WAHA. Fail-open a nivel controller: si WAHA está caído, tiramos
    // 502 explícito para que el frontend pueda reintentar. NO guardamos el
    // mensaje si el envío falló — mantener consistencia con la conversación
    // real del paciente.
    try {
      await this.waha.sendText(convo.clinic.wahaSession, convo.chatId, dto.text);
    } catch (e) {
      this.logger.error(
        `waha reply falló convoId=${id}: ${(e as Error).message}`,
      );
      throw new BadRequestException('no se pudo enviar el mensaje por WhatsApp');
    }

    const msg = await this.prisma.message.create({
      data: {
        conversationId: id,
        direction: 'OUT',
        body: dto.text,
      },
    });
    // Bump updatedAt para que la bandeja re-ordene. Luxon en vez de `new Date()`
    // para respetar la regla dura del proyecto (nunca Date naive).
    await this.prisma.conversation.update({
      where: { id },
      data: { updatedAt: DateTime.now().toJSDate() },
    });
    this.logger.log(
      `convo reply convoId=${id} msgId=${msg.id} chars=${dto.text.length}`,
    );
    return { id: msg.id, body: msg.body, createdAt: msg.createdAt };
  }

  @Post(':id/release')
  @HttpCode(200)
  async release(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    const existing = await this.prisma.conversation.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('conversación no encontrada');
    // Reset del estado del bot: state = BOT + limpia FSM step/data para que
    // no re-tome un estado obsoleto al próximo mensaje.
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        state: ConversationState.BOT,
        flowStep: null,
        flowData: Prisma.JsonNull,
      },
      select: { id: true, state: true },
    });
    this.logger.log(`convo release convoId=${id} by=${user.userId}`);
    return updated;
  }
}
