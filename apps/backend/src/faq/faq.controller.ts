import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { tenantWhere, type AuthUser } from '../auth/tenant-context.util';
import {
  KnowledgeService,
  KnowledgeUnavailableError,
} from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';

/** Shape mínima que necesitamos de `express.Response` — evita importar
 * `@types/express` (no está en las devDependencies del backend). Cualquier
 * Response HTTP con `setHeader(name, value)` cumple, sea Fastify o Express. */
interface ResponseLike {
  setHeader(name: string, value: string): unknown;
}

/**
 * CRUD de `FaqChunk` con soporte RAG (embeddings vía `KnowledgeService`).
 *
 * Comportamiento sin `OPENAI_API_KEY`:
 * - `POST` guarda el chunk SIN embedding y responde 201 con header
 *   `X-Warning: embedding-skipped-no-openai-key`. El operador puede correr
 *   `pnpm prisma:reindex-faq` cuando la key esté disponible para poblar
 *   los embeddings faltantes.
 * - `PATCH` intenta re-embed. Si falla por falta de key, actualiza `content`
 *   pero deja `embedding` como estaba (posiblemente stale — el warning header
 *   avisa al operador).
 *
 * Response: NO exponemos `embedding` (payload grande + inútil en UI).
 */
@Controller('faq')
@UseGuards(RolesGuard)
@Roles('CLINIC_ADMIN', 'SUPERADMIN')
export class FaqController {
  private readonly logger = new Logger(FaqController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFaqDto,
    @Res({ passthrough: true }) res: ResponseLike,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    // Camino feliz: ingest via KnowledgeService (embed + insert por raw SQL).
    try {
      const created = await this.knowledge.ingest({
        clinicId: scope.clinicId,
        content: dto.content,
      });
      // Devolvemos la misma shape que antes (id/clinicId/content/createdAt).
      // Fetch mínimo desde DB para `createdAt` (el ingest raw no lo retorna).
      const stored = await this.prisma.faqChunk.findFirst({
        where: { id: created.id, clinicId: scope.clinicId },
        select: { id: true, clinicId: true, content: true, createdAt: true },
      });
      return stored ?? { ...created, clinicId: scope.clinicId };
    } catch (e) {
      // Sin OPENAI_API_KEY: guardamos el chunk SIN embedding. El operador
      // puede correr el CLI de reindex cuando la key esté disponible.
      if (e instanceof KnowledgeUnavailableError) {
        res.setHeader('X-Warning', 'embedding-skipped-no-openai-key');
        const created = await this.prisma.faqChunk.create({
          data: { clinicId: scope.clinicId, content: dto.content },
          select: { id: true, clinicId: true, content: true, createdAt: true },
        });
        this.logger.warn(
          `faq created sin embedding clinicId=${scope.clinicId} chunkId=${created.id} (OPENAI_API_KEY faltante)`,
        );
        return created;
      }
      throw e;
    }
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    return this.prisma.faqChunk.findMany({
      where: tenantWhere(user, clinicIdOverride),
      orderBy: { createdAt: 'desc' },
      select: { id: true, clinicId: true, content: true, createdAt: true },
    });
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const item = await this.prisma.faqChunk.findFirst({
      where: { id, ...tenantWhere(user, clinicIdOverride) },
      select: { id: true, clinicId: true, content: true, createdAt: true },
    });
    if (!item) throw new NotFoundException('faq no encontrado');
    return item;
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateFaqDto,
    @Res({ passthrough: true }) res: ResponseLike,
    @Query('clinicId') clinicIdOverride?: string,
  ) {
    const scope = tenantWhere(user, clinicIdOverride);
    // Nota: NO hacemos `findFirst → prisma.update({ where: { id } })` porque
    // eso deja una carrera de tenant leaks (findFirst pasa, PATCH pasa a otra
    // clínica si el id se re-mapea entre ambas queries). Usamos updateMany
    // con `where: { id, clinicId }` — atómico, tenant-safe, y `count === 0`
    // nos da el 404 sin race.
    if (dto.content !== undefined) {
      try {
        await this.knowledge.updateChunk({
          id,
          clinicId: scope.clinicId,
          content: dto.content,
        });
      } catch (e) {
        if (e instanceof KnowledgeUnavailableError) {
          // Sin OPENAI_API_KEY: actualizamos content pero el embedding queda
          // como estaba (stale). Header le avisa al operador que debe correr
          // el reindex después. Usamos updateMany con filtro por clinicId
          // para blindar contra cross-tenant.
          res.setHeader('X-Warning', 'embedding-skipped-no-openai-key');
          const result = await this.prisma.faqChunk.updateMany({
            where: { id, clinicId: scope.clinicId },
            data: { content: dto.content },
          });
          if (result.count === 0) {
            throw new NotFoundException('faq no encontrado');
          }
          this.logger.warn(
            `faq updated sin re-embed clinicId=${scope.clinicId} chunkId=${id} (OPENAI_API_KEY faltante)`,
          );
        } else {
          throw e;
        }
      }
    }

    // Verificamos existencia + tenant en el SELECT final: si el updateChunk
    // (raw SQL con WHERE clinicId) no matcheó, este SELECT tampoco → 404.
    const stored = await this.prisma.faqChunk.findFirst({
      where: { id, clinicId: scope.clinicId },
      select: { id: true, clinicId: true, content: true, createdAt: true },
    });
    if (!stored) throw new NotFoundException('faq no encontrado');
    return stored;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('clinicId') clinicIdOverride?: string,
  ): Promise<void> {
    const scope = tenantWhere(user, clinicIdOverride);
    // Idem al update: `deleteMany` con filtro por tenant evita race
    // condiciones y garantiza el 404 sin dos queries.
    const result = await this.prisma.faqChunk.deleteMany({
      where: { id, clinicId: scope.clinicId },
    });
    if (result.count === 0) throw new NotFoundException('faq no encontrado');
  }
}
