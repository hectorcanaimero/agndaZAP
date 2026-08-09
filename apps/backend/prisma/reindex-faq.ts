/**
 * reindex-faq — CLI standalone para poblar embeddings faltantes.
 *
 * Contexto: `POST /api/faq` acepta chunks aún si `OPENAI_API_KEY` no está
 * seteada (los guarda con `embedding = NULL` + warning header). Este script
 * hace el catch-up: escanea `FaqChunk WHERE embedding IS NULL`, genera el
 * embedding vía `KnowledgeService.embedText`, y hace UPDATE con el vector.
 *
 * Uso:
 *   pnpm --filter @agendazap/backend prisma:reindex-faq
 *
 * Requiere `OPENAI_API_KEY` en el env. Si falta, sale con exit code 1 y
 * mensaje claro — a diferencia del create, acá no tiene sentido degradar.
 *
 * Cero PII en logs: sólo `clinicId`, `chunkId`, `contentLen`, `status`.
 * No loggeamos el `content` de la FAQ.
 *
 * Idempotente: el UPDATE es por `id` y sólo procesa chunks con
 * `embedding IS NULL`. Correrlo dos veces seguidas → segunda vuelta es no-op.
 */
import { PrismaClient } from '@prisma/client';
import {
  KnowledgeService,
  KnowledgeUnavailableError,
} from '../src/knowledge/knowledge.service';

const prisma = new PrismaClient();

async function main() {
  // Guard suave para producción: es válido correr el reindex en prod (ese es
  // el use-case principal — poblar embeddings después de agregar OPENAI_API_KEY),
  // pero como toca miles de rows en la DB, exigimos confirmación explícita
  // para que nadie lo corra por accidente desde un shell equivocado.
  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.CONFIRM_PROD_REINDEX
  ) {
    console.error(
      'reindex-faq: en producción, exportá CONFIRM_PROD_REINDEX=1 para confirmar.',
    );
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'reindex-faq: OPENAI_API_KEY no está seteada. Abortando (no hay proveedor de embeddings).',
    );
    process.exit(1);
  }

  const knowledge = new KnowledgeService(prisma as unknown as any);

  // Sólo chunks sin embedding — evitamos re-embedear todo cada vez.
  // Nota: `embedding` es tipo `Unsupported(vector)` en el schema, así que
  // usamos raw SQL para el SELECT del filtro.
  const pending = (await prisma.$queryRawUnsafe(
    `SELECT id, "clinicId", content FROM "FaqChunk" WHERE embedding IS NULL ORDER BY "createdAt" ASC`,
  )) as Array<{ id: string; clinicId: string; content: string }>;

  console.log(`reindex-faq: ${pending.length} chunks pendientes`);

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const chunk = pending[i];
    const progress = `[${i + 1}/${pending.length}]`;
    try {
      await knowledge.updateChunk({
        id: chunk.id,
        clinicId: chunk.clinicId,
        content: chunk.content,
      });
      ok++;
      console.log(
        `${progress} OK chunkId=${chunk.id} clinicId=${chunk.clinicId} contentLen=${chunk.content.length}`,
      );
    } catch (e) {
      failed++;
      if (e instanceof KnowledgeUnavailableError) {
        // No debería pasar (validamos al inicio), pero por si el env cambia
        // mid-run. Salimos temprano: sin key el resto de chunks también fallará.
        console.error(
          `${progress} FAIL chunkId=${chunk.id}: OPENAI_API_KEY perdida durante la ejecución. Abortando.`,
        );
        break;
      }
      console.error(
        `${progress} FAIL chunkId=${chunk.id} clinicId=${chunk.clinicId}: ${
          (e as Error).message
        }`,
      );
    }
  }

  console.log(`\nreindex-faq: done. ok=${ok} failed=${failed} total=${pending.length}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('reindex-faq failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
