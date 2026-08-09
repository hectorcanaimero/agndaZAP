# ADR 0009 — FAQ: `title` opcional y strip de markdown antes del embedding

- Fecha: 2026-08-09
- Estado: aceptado
- Relacionados: [[../notas/2026-08-09-rag-faq]], [[0004-pii-y-compliance]], [[0006-panel-mvp-y-deuda]]

## Contexto

El modelo `FaqChunk` tenía solamente los campos `content` (string) y `embedding`
(vector 1536). La UI actual del panel de "Preguntas frecuentes" se estaba
usando como base de conocimiento libre: el operador escribía markdown con
títulos (`# Horarios`), listas, negritas, etc. dentro del mismo `content`.

Dos problemas prácticos que salieron del piloto interno:

1. **UI sin etiqueta**: cada tarjeta mostraba el `content` completo como
   preview, sin un título corto. La lista se volvía ilegible con más de 5
   entradas. El workaround del operador era prefijar la primera línea como
   "título" (`# Nombre`), lo cual funciona en render pero es un hack —
   nada garantiza el formato y no se puede filtrar/buscar por título.
2. **Ruido en el embedding**: `text-embedding-3-small` tokeniza los símbolos
   markdown (`**`, `#`, `-`, backticks) como si fueran contenido. Un chunk
   con mucho markdown tiene un vector "corrido" por sintaxis irrelevante, lo
   que degrada el recall del retrieval: la pregunta del paciente
   ("¿a qué hora abren?", texto plano) no matchea bien contra un chunk
   `# Horarios\n\n**Atención**: L-V 9-18h`.

Además, la sección se está rediseñando a "Base de conocimiento" con editor
markdown de primera clase — necesitábamos un lugar formal para el título.

## Decisión

1. **Agregar `title String?` opcional al modelo `FaqChunk`** (migración
   `20260809185807_faq_add_title_field`). Se acepta desde el DTO
   (`title?: string` con `@IsOptional() @IsString() @MaxLength(200)`),
   se guarda tal cual en DB, se retorna en la response.

2. **Strippear markdown ANTES del embedding**, no antes del guardado.
   El `content` en DB sigue siendo el markdown crudo que el operador
   escribió (para render fiel en el editor y en cualquier UI futura).
   Sólo el string que va a OpenAI se limpia via `remove-markdown`
   (helper privado `KnowledgeService.toEmbeddingText`).

3. **Prefijar el `title` al plain-text del embedding** cuando existe. La
   pregunta del paciente suele parecerse al título ("horarios",
   "dirección", "precio"), así que ponerlo primero le da peso en el
   vector y mejora el recall del retrieval.

4. **En `updateChunk`, si el caller no manda `title`**, el service lee
   el título vigente de DB antes de re-embedear (extra roundtrip pero
   mantiene el vector coherente con lo que se muestra).

## Consecuencias

### Positivas

- La UI puede mostrar `title` como etiqueta corta en la lista y `content`
  como body en el editor. Fin del hack de "primera línea es el título".
- El vector de embedding indexa **significado, no formato** — chunks con
  o sin markdown producen embeddings comparables. Mejora recall sin
  cambiar el modelo.
- Migración retrocompatible: `title` es `NULL` para los chunks viejos.
  Ninguno se re-embedea automáticamente — el operador puede correr
  `pnpm prisma:reindex-faq` cuando quiera regenerar con el nuevo pipeline.
- Se conserva el markdown crudo en DB → future-proof para renderers
  distintos (React Markdown, exportación PDF, etc.).

### Negativas / tradeoffs

- **Un extra roundtrip a DB en `updateChunk`** cuando el caller no manda
  `title` (para leer el vigente). Aceptable: los updates de FAQ son
  low-frequency (operador humano, no bot).
- **`remove-markdown` es un dep runtime** (~30KB, sin subdeps). Alternativa
  descartada: regex casero para strip — más frágil, no vale la pena
  ahorrar 30KB.
- **Chunks pre-migración quedan con vectores "sucios"** hasta que se
  re-indexen. Convivimos con eso: el operador decide cuándo correr el
  reindex (o dejarlos como están si funcionan).
- **`title` no valida anti-injection** — sólo `content` lo hace. Rationale:
  el `title` va prefijado al plain-text del embedding pero NO al system
  prompt del LLM (que sólo ve `content` sanitizado con reemplazo de `---`).
  Si esto cambia, hay que agregar la misma guarda al DTO de `title`.

## Alternativas descartadas

- **`title` computed** (extraer la primera línea del content): frágil y
  acoplado al formato; imposible editar el título sin tocar el body.
- **Split del content en múltiples chunks por sección**: overhead grande
  para el MVP; los chunks actuales de clínica son cortos (< 400 chars
  promedio) y caben bien en un vector solo.
- **Guardar el content ya strippeado**: perdés el markdown crudo para el
  editor. Peor UX.
