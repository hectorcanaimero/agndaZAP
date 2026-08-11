import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { extractIp, MinimalRequest } from '../common/extract-ip';
import { RateLimit } from '../public/rate-limit.guard';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsService } from './leads.service';

/**
 * LeadsController — endpoint público para el form de la landing (FinalCta).
 *
 * Reglas de higiene (idénticas al `PublicController` de agendamiento):
 * - Sin auth (`@Public()`), opt-out del `JwtAuthGuard` global.
 * - Rate-limit 5/min con scope `leads` (Redis, fixed window) — evita spam
 *   masivo desde una misma IP sin bloquear al humano que corrige un dato.
 * - Honeypot: si viene con valor, respondemos 200 SIN persistir. No lo
 *   señalizamos vía 400 para no enseñarle al bot que existe la trampa.
 * - Cero PII en logs: sólo ip + status + presencia de campos opcionales.
 *
 * Response shape idéntica en éxito y honeypot para no filtrar cuál caso ocurrió.
 * Bot y humano ven el mismo `{ ok: true }`.
 */
@Public()
@Controller('public/leads')
export class LeadsController {
  private readonly logger = new Logger('LeadsController');
  private readonly trustProxy = process.env.TRUST_PROXY === 'true';

  constructor(private readonly leads: LeadsService) {}

  @Post()
  @UseGuards(RateLimit(5, 'leads'))
  @HttpCode(201)
  async create(
    @Body() dto: CreateLeadDto,
    @Req() req: MinimalRequest,
  ): Promise<{ ok: true }> {
    if (dto.honeypot && dto.honeypot.length > 0) {
      this.logger.warn('honeypot triggered scope=leads');
      return { ok: true };
    }

    // Normalizamos phone: agregamos `+` si no lo trae (E.164 estricto).
    // Mismo criterio que el endpoint de agendamiento — un solo shape en DB.
    const normalizedPhone = dto.phone.startsWith('+')
      ? dto.phone
      : `+${dto.phone}`;

    // IP y userAgent para auditoría anti-abuso. `userAgent` puede ser útil para
    // segmentar mobile vs desktop en analytics. Truncamos a 500 chars (mismo
    // límite del schema) para evitar payloads inflados.
    const ip = extractIp(req, this.trustProxy);
    const uaHeader = req.headers['user-agent'];
    const userAgent =
      typeof uaHeader === 'string' ? uaHeader.slice(0, 500) : undefined;

    await this.leads.create({
      name: dto.name,
      phone: normalizedPhone,
      clinicType: dto.clinicType,
      notes: dto.notes,
      locale: dto.locale,
      ip: ip !== 'unknown' && ip !== 'invalid' ? ip : undefined,
      userAgent,
    });

    return { ok: true };
  }
}
