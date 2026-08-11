import { Injectable, Logger } from '@nestjs/common';
import type { Lead, LeadStatus, Prisma } from '@prisma/client';
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

interface ListLeadsInput {
  status?: LeadStatus;
  page: number;
  pageSize: number;
}

export interface ListLeadsResult {
  items: Lead[];
  total: number;
  page: number;
  pageSize: number;
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

  /**
   * Listado paginado para el panel admin. Los leads son cross-tenant (no
   * tienen `clinicId`), así que la única defensa es el rol del caller —
   * lo enforcea el controller vía `@Roles('SUPERADMIN')`.
   *
   * Orden: `createdAt desc` (últimos primero — el owner mira arriba
   * los recién llegados). Devolvemos `total` para paginación real,
   * sin correr un COUNT(*) por página cuando el filtro no cambia
   * (TanStack Query cachea por queryKey).
   */
  async findAll(input: ListLeadsInput): Promise<ListLeadsResult> {
    const { status, page, pageSize } = input;
    const where: Prisma.LeadWhereInput = status ? { status } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }
}
