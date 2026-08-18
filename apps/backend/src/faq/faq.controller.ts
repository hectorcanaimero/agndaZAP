import {
  Body,
  Controller,
  Delete,
  Get,
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
 * Shape público del `FaqChunk` que devolvemos al cliente. NO incluye el vector
 * `embedding` — sólo el booleano `hasEmbedding` derivado. El operador necesita
 * saber si la FAQ está indexada (bot puede responder) o no (bot hace handoff
 * silencioso, ver [[notas/2026-08-09-rag-faq]]).
 */
interface FaqChunkResponse {
  id: string;
  clinicId: string;
  title: string | null;
  content: string;
  createdAt: Date;
  hasEmbedding: boolean;
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

  /**
   * Query raw que retorna la shape pública (`FaqChunkResponse`) directamente,
   * sin cargar el vector `embedding` a memoria. Postgres computa el flag
   * `embedding IS NOT NULL` in-DB — el payload del network trip nunca contiene
   * los 1536 floats.
   *
   * Multi-tenant: `clinicId` va como parámetro `$1` (parametrizado). El WHERE
   * puede extenderse con `AND id = $2` para el flujo findOne/create/update.
   *
   * NOTA: usamos `$queryRawUnsafe` con el WHERE construido — el único
   * "unsafe" es el `WHERE` clause que armamos localmente (sólo con fragmentos
   * whitelisted `AND id = $2`). Todos los valores van parametrizados.
   */
  private async selectFaqChunks(
    clinicId: string,
    extraFilter: { id?: string } = {},
  ): Promise<FaqChunkResponse[]> {
    if (extraFilter.id) {
      return this.prisma.$queryRawUnsafe<FaqChunkResponse[]>(
        `SELECT id, "clinicId", title, content, "createdAt", (embedding IS NOT NULL) AS "hasEmbedding"
         FROM "FaqChunk"
         WHERE "clinicId" = $1 AND id = $2`,
        clinicId,
        extraFilter.id,
      );
    }
    return this.prisma.$queryRawUnsafe<FaqChunkResponse[]>(
      `SELECT id, "clinicId", title, content, "createdAt", (embedding IS NOT NULL) AS "hasEmbedding"
       FROM "FaqChunk"
       WHERE "clinicId" = $1
       ORDER BY "createdAt" DESC`,
      clinicId,
    );
  }

  /** Convenience: mismo query que `selectFaqChunks` pero para un id específico
   * y con guard 404. Devuelve la shape pública con `hasEmbedding`. */
  private async selectFaqChunkById(
    clinicId: string,
    id: string,
  ): Promise<FaqChunkResponse> {
    const rows = await this.selectFaqChunks(clinicId, { id });
    const item = rows[0];
    if (!item) throw new NotFoundException('faq no encontrado');
    return item;
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFaqDto,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<FaqChunkResponse> {
    const scope = tenantWhere(user);
    // Normalizamos `title`: vacío/whitespace → null. Evita filas con `""` que
    // ensucian la UI y el embedding (el toEmbeddingText también lo maneja,
    // pero mejor consistente desde el borde).
    const normalizedTitle = dto.title && dto.title.trim().length > 0
      ? dto.title.trim()
      : null;
    // Camino feliz: ingest via KnowledgeService (embed + insert por raw SQL).
    try {
      const created = await this.knowledge.ingest({
        clinicId: scope.clinicId,
        content: dto.content,
        title: normalizedTitle,
      });
      // Fetch de la shape pública (incluye `hasEmbedding: true`). No traemos
      // el vector — el flag se computa in-DB.
      return await this.selectFaqChunkById(scope.clinicId, created.id);
    } catch (e) {
      // Sin OPENAI_API_KEY: guardamos el chunk SIN embedding. El operador
      // puede correr el CLI de reindex cuando la key esté disponible.
      if (e instanceof KnowledgeUnavailableError) {
        res.setHeader('X-Warning', 'embedding-skipped-no-openai-key');
        const created = await this.prisma.faqChunk.create({
          data: {
            clinicId: scope.clinicId,
            title: normalizedTitle,
            content: dto.content,
          },
          select: {
            id: true,
            clinicId: true,
            title: true,
            content: true,
            createdAt: true,
          },
        });
        this.logger.warn(
          `faq created sin embedding clinicId=${scope.clinicId} chunkId=${created.id} (OPENAI_API_KEY faltante)`,
        );
        // `hasEmbedding: false` — el bot no puede responder esta FAQ todavía.
        // El frontend debe mostrar el badge amarillo y contar en el banner.
        return { ...created, hasEmbedding: false };
      }
      throw e;
    }
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
  ): Promise<FaqChunkResponse[]> {
    const scope = tenantWhere(user);
    return this.selectFaqChunks(scope.clinicId);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<FaqChunkResponse> {
    const scope = tenantWhere(user);
    return this.selectFaqChunkById(scope.clinicId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateFaqDto,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<FaqChunkResponse> {
    const scope = tenantWhere(user);
    // Normalización de title: sólo si el caller lo mandó (undefined = no tocar).
    // "" o whitespace → null (limpia el título en DB).
    const normalizedTitle =
      dto.title === undefined
        ? undefined
        : dto.title && dto.title.trim().length > 0
          ? dto.title.trim()
          : null;
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
          title: normalizedTitle,
        });
      } catch (e) {
        if (e instanceof KnowledgeUnavailableError) {
          // Sin OPENAI_API_KEY: actualizamos content (y title si vino) pero el
          // embedding queda como estaba (stale). Header le avisa al operador
          // que debe correr el reindex después. Usamos updateMany con filtro
          // por clinicId para blindar contra cross-tenant.
          res.setHeader('X-Warning', 'embedding-skipped-no-openai-key');
          const data: { content: string; title?: string | null } = {
            content: dto.content,
          };
          if (normalizedTitle !== undefined) data.title = normalizedTitle;
          const result = await this.prisma.faqChunk.updateMany({
            where: { id, clinicId: scope.clinicId },
            data,
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
    } else if (normalizedTitle !== undefined) {
      // Sólo `title` cambia — no toca embedding (title solo). Igual va por
      // updateMany con filtro clinicId para tenant-safety.
      const result = await this.prisma.faqChunk.updateMany({
        where: { id, clinicId: scope.clinicId },
        data: { title: normalizedTitle },
      });
      if (result.count === 0) {
        throw new NotFoundException('faq no encontrado');
      }
    }

    // Verificamos existencia + tenant en el SELECT final: si el updateChunk
    // (raw SQL con WHERE clinicId) no matcheó, este SELECT tampoco → 404.
    // La response trae `hasEmbedding` para que el frontend refresque el badge
    // sin refetch (si volvió la key, la FAQ ya está indexada y bot puede
    // responderla).
    return this.selectFaqChunkById(scope.clinicId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    const scope = tenantWhere(user);
    // Idem al update: `deleteMany` con filtro por tenant evita race
    // condiciones y garantiza el 404 sin dos queries.
    const result = await this.prisma.faqChunk.deleteMany({
      where: { id, clinicId: scope.clinicId },
    });
    if (result.count === 0) throw new NotFoundException('faq no encontrado');
  }
}
