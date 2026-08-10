import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Query,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { IcalService } from './ical.service';

/**
 * `GET /professionals/:id/ical?token=X` — **público** (opt-out del JWT guard
 * global) porque los clientes iCal (iOS/Android/Google Calendar) no envían
 * Authorization Bearer al suscribir feeds. La autenticidad se prueba con el
 * token HMAC en el query string.
 *
 * IMPORTANTE: el path vive fuera del prefijo `/api` (excluido en `main.ts` —
 * ver también `WebhookController` que sigue el mismo patrón). El `@Public()`
 * en el controller opt-outea del `JwtAuthGuard` global.
 *
 * Devuelve `text/calendar; charset=utf-8` con CRLF (RFC 5545).
 */
@Public()
@Controller('ical')
export class ProfessionalsIcalController {
  constructor(private readonly ical: IcalService) {}

  @Get('professionals/:id')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Cache-Control', 'private, max-age=60')
  async feed(
    @Param('id') id: string,
    @Query('token') token?: string,
  ): Promise<string> {
    if (!this.ical.verifyToken(id, token)) {
      // Sin filtrar por qué falló — no dar señal a un attacker de si el ID
      // existe o si el token está mal formado.
      throw new ForbiddenException('token inválido');
    }
    return this.ical.buildFeed(id);
  }
}
