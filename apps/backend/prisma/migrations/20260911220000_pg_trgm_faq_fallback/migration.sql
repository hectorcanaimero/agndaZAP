-- Fallback léxico del RAG (M8).
--
-- `text-embedding-3-small` falla justo con las preguntas cortas y coloquiales
-- que llegan por WhatsApp: "donde estan ubicados" daba 0.619 de distancia
-- contra el chunk correcto, por encima del umbral de 0.65 solo por poco, y
-- "dónde queda la clínica" matcheaba el chunk equivocado. Ver
-- docs/notas/2026-09-10-rag-umbral-distancia.md.
--
-- pg_trgm permite buscar por parecido de texto cuando el vector no da nada.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índice GIN para que `word_similarity` no haga seq-scan. Con clínicas de
-- 10-50 chunks daría igual, pero el índice es barato y evita tener que
-- acordarse cuando una crezca.
CREATE INDEX IF NOT EXISTS "FaqChunk_content_trgm_idx"
  ON "FaqChunk" USING GIN ("content" gin_trgm_ops);
