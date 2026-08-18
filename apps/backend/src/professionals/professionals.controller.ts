import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { ProfessionalProfileFieldsDto } from './dto/professional-profile-fields.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';
import { IcalService } from './ical.service';

/**
 * CRUD de `Professional`. Soft-delete via `active = false`.
 * M-N con `Service` — `serviceIds` opcional en create/patch.
 */
@Controller('professionals')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class ProfessionalsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ical: IcalService,
  ) {}

  /**
   * Valida que todos los `serviceIds` pertenecen a la misma clínica del scope.
   * Sin esto, `connect`/`set` linkearía servicios cross-tenant (audit B1).
   */
  private async assertServicesInScope(
    ids: string[],
    clinicId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.service.findMany({
      where: { id: { in: ids }, clinicId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'algún serviceId no pertenece a esta clínica',
      );
    }
  }

  /**
   * Extrae solo los campos de perfil que vienen definidos en el DTO. Filtramos
   * `undefined` para NO pisar valores en DB en un patch parcial. Los strings
   * vacíos que llegaron los normaliza ya el `@Transform` del DTO a `undefined`.
   * Devuelve `Record<string, string>` — sirve tanto para `ProfessionalCreateInput`
   * como `UpdateInput` (los campos escalares se aceptan como strings directos).
   */
  private pickProfileFields(
    dto: ProfessionalProfileFieldsDto,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (dto.email !== undefined) out.email = dto.email;
    if (dto.phone !== undefined) out.phone = dto.phone;
    if (dto.specialty !== undefined) out.specialty = dto.specialty;
    if (dto.bio !== undefined) out.bio = dto.bio;
    if (dto.avatarUrl !== undefined) out.avatarUrl = dto.avatarUrl;
    if (dto.licenseNumber !== undefined)
      out.licenseNumber = dto.licenseNumber;
    if (dto.color !== undefined) out.color = dto.color;
    return out;
  }

  /**
   * Traduce el `P2002` de Prisma (unique constraint) a un `409 Conflict` claro.
   * Hoy el único unique compuesto es `[clinicId, email]` — otro profesional ya
   * usa ese email en la misma clínica.
   */
  private throwIfEmailTaken(err: unknown): never {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ConflictException(
        'ese email ya está registrado para otro profesional de esta clínica',
      );
    }
    throw err as Error;
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProfessionalDto,
  ) {
    const scope = tenantWhere(user);
    if (dto.serviceIds && dto.serviceIds.length > 0) {
      await this.assertServicesInScope(dto.serviceIds, scope.clinicId);
    }
    try {
      return await this.prisma.professional.create({
        data: {
          clinicId: scope.clinicId,
          name: dto.name,
          active: true,
          ...this.pickProfileFields(dto),
          ...(dto.serviceIds && dto.serviceIds.length > 0
            ? {
                services: {
                  // Pre-validado arriba: sólo IDs del mismo tenant.
                  connect: dto.serviceIds.map((id) => ({ id })),
                },
              }
            : {}),
        },
      });
    } catch (e) {
      this.throwIfEmailTaken(e);
    }
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
  ) {
    return this.prisma.professional.findMany({
      where: { ...tenantWhere(user), active: true },
      orderBy: { name: 'asc' },
      include: {
        services: { where: { active: true }, select: { id: true, name: true } },
      },
    });
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    const prof = await this.prisma.professional.findFirst({
      where: { id, ...tenantWhere(user) },
      include: {
        services: { select: { id: true, name: true } },
      },
    });
    if (!prof) throw new NotFoundException('profesional no encontrado');
    // URL del iCal feed pre-firmada — la devolvemos junto al detalle para que
    // el frontend pueda mostrar un botón "Copiar URL de calendar". El path vive
    // fuera de /api (ver ProfessionalsIcalController) y no requiere auth JWT —
    // el token HMAC en el query string es la credencial.
    const icalUrl = `/ical/professionals/${prof.id}?token=${this.ical.tokenFor(prof.id)}`;
    return { ...prof, icalUrl };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProfessionalDto,
  ) {
    const scope = tenantWhere(user);
    const existing = await this.prisma.professional.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('profesional no encontrado');

    if (dto.serviceIds && dto.serviceIds.length > 0) {
      await this.assertServicesInScope(dto.serviceIds, scope.clinicId);
    }

    try {
      return await this.prisma.professional.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.followUpEnabled !== undefined
            ? { followUpEnabled: dto.followUpEnabled }
            : {}),
          ...(dto.followUpDelayHours !== undefined
            ? { followUpDelayHours: dto.followUpDelayHours }
            : {}),
          ...this.pickProfileFields(dto),
          ...(dto.serviceIds
            ? {
                services: {
                  // Pre-validado arriba: `set` sólo con IDs del mismo tenant.
                  set: dto.serviceIds.map((sid) => ({ id: sid })),
                },
              }
            : {}),
        },
      });
    } catch (e) {
      this.throwIfEmailTaken(e);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    const scope = tenantWhere(user);
    const existing = await this.prisma.professional.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('profesional no encontrado');
    await this.prisma.professional.update({
      where: { id },
      data: { active: false },
    });
  }
}
