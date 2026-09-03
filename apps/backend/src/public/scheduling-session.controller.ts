import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { SchedulingSessionService } from '../scheduling/scheduling-session.service';
import { RateLimit } from './rate-limit.guard';

/**
 * PublicSchedulingSessionController — endpoint público que hidrata el form
 * `/agendar/[slug]?t=xxx`.
 *
 * Flujo:
 *   Bot manda link con `?t=<token>` → paciente abre la página → Next.js
 *   (server component) hace `GET /api/public/scheduling/session/:token` →
 *   devuelve `{ clinicSlug, name, phone, phoneEditable }` para pre-llenar el
 *   form → el usuario elige slot y postea → `POST /public/:slug/appointments`
 *   con el mismo `token` en el body → el token se CONSUME allí (single-use).
 *
 * Por qué `resolve()` acá y `consume()` en el POST:
 *   El usuario puede recargar el form varias veces mientras elige horario. Si
 *   consumíeramos acá, el segundo GET fallaría. El consume tiene que pasar
 *   exactamente cuando la cita se crea — así "un token, una cita".
 *
 * Rate-limit por scope explícito 'sched-sess' (no por slug, porque acá el
 * "slug" es el token que ya trae entropía). Bucket 60/min por IP: laxo, porque
 * un usuario legítimo puede recargar varias veces.
 */
@Public()
@Controller('public/scheduling/session')
export class PublicSchedulingSessionController {
  private readonly logger = new Logger('PublicSchedulingSessionController');

  constructor(private readonly sessions: SchedulingSessionService) {}

  /**
   * Hidrata el form desde el token.
   *
   * Response shape:
   *   - `clinicSlug`: el front redirige si no coincide con la URL actual.
   *   - `name`: pre-fill del input nombre (editable — la persona puede corregir).
   *   - `phone`: pre-fill del input teléfono. NULL cuando la conversación es
   *     `@lid` y todavía no tenemos el número — el form lo pide como required.
   *   - `phoneEditable`: `false` cuando `phone` está presente (no queremos que
   *     lo cambien y rompan el linkeo WA↔cita). `true` cuando `phone === null`.
   *
   * NO devolvemos `conversationId` — es dato interno; el front no lo necesita
   * y no queremos exponerlo por URL/network.
   *
   * 404 si el token no existe o expiró; el front muestra "tu link expiró".
   */
  @Get(':token')
  @UseGuards(RateLimit(60, 'sched-sess'))
  async getSession(@Param('token') token: string): Promise<{
    clinicSlug: string;
    name: string | null;
    phone: string | null;
    phoneEditable: boolean;
  }> {
    const session = await this.sessions.resolve(token);
    if (!session) {
      // Log sin PII: sólo el prefix del token. No exponemos si "no existe" vs.
      // "expiró" — el front trata ambos como "pedí otro link".
      this.logger.warn(
        `session hydrate miss token=${(token ?? '').slice(0, 6)}…`,
      );
      throw new NotFoundException('link inválido o expirado');
    }

    return {
      clinicSlug: session.clinicSlug,
      name: session.name,
      phone: session.phone,
      phoneEditable: session.phone === null,
    };
  }
}
