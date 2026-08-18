import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { RateLimit } from '../public/rate-limit.guard';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import {
  InvitationsService,
  type PublicInvitationInfo,
} from './invitations.service';

/**
 * Endpoints públicos para el flujo de aceptación de invitación.
 *
 * Ambos van bajo `/api/public/invitations` para reflejar que NO requieren
 * autenticación — el token en el path es el credential. Se marcan con
 * `@Public()` para saltar el `JwtAuthGuard` global.
 *
 * Rate-limit:
 * - `GET`: 30 req/min por IP — genera consulta a DB por lookup pero es
 *   ligero, permitimos vueltas de recarga.
 * - `POST accept`: 10 req/min por IP — el token es alta entropía, el ataque
 *   real sería enumerar tokens; limitar por IP corta ese vector.
 */
@Controller('public/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * `GET /api/public/invitations/:token`
   *
   * Devuelve la info mínima para mostrar la página `/invite/[token]`:
   * a quién saluda (nombre), a qué clínica se invita, y cuándo vence.
   * NO expone `userId`, `clinicId` ni el email del que invitó.
   */
  @Get(':token')
  @Public()
  @UseGuards(RateLimit(30, 'invitations-get'))
  get(@Param('token') token: string): Promise<PublicInvitationInfo> {
    return this.invitations.getByToken(token);
  }

  /**
   * `POST /api/public/invitations/:token/accept`
   *
   * Body `{ plainPassword }`. En éxito, hashea + asigna al User + marca
   * la invitación como consumida. Idempotencia: un segundo intento
   * responde 410 Gone.
   *
   * Devuelve 204 No Content — no hay payload útil, y evita dar señales
   * al cliente sobre el user creado (defensivo).
   */
  @Post(':token/accept')
  @Public()
  @UseGuards(RateLimit(10, 'invitations-accept'))
  @HttpCode(204)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<void> {
    await this.invitations.accept(token, dto.plainPassword);
  }
}
