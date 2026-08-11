import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface CreateLeadInput {
  name: string;
  phone: string; // ya normalizado con `+` por el controller
  clinicType?: string;
  notes?: string;
  locale: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Persistencia de leads de marketing (prospects capturados en la landing).
 *
 * No hay lógica de tenant acá — los leads no pertenecen a una Clinic, son
 * candidatos a serlo. El follow-up es manual: el owner ve la lista y contacta
 * al prospect por WhatsApp.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger('LeadsService');

  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateLeadInput): Promise<{ id: string }> {
    const lead = await this.prisma.lead.create({
      data: {
        name: input.name,
        phone: input.phone,
        clinicType: input.clinicType ?? null,
        notes: input.notes ?? null,
        locale: input.locale,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      select: { id: true },
    });

    // Cero PII en logs. Sólo id + locale + presencia de clinicType.
    this.logger.log(
      `lead created id=${lead.id} locale=${input.locale} clinicType=${input.clinicType ?? '-'}`,
    );
    return lead;
  }
}
