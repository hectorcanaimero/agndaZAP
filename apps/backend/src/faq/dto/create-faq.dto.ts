import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Regex anti prompt-injection. Rechaza los patrones más obvios que un atacante
 * usaría al cargar una FAQ desde el panel para envenenar el contexto del bot:
 *
 * - Delimitadores de fuente del prompt de `KnowledgeService.answer` (`--- FUENTE`,
 *   `--- FIN FUENTE`). Si el content los incluye, el atacante puede simular una
 *   fuente distinta o cerrar el bloque antes de tiempo.
 * - Instrucciones estándar de jailbreak ("ignore previous instructions",
 *   "olvidá todo", "desestimá", "sos ahora un…", "actúa como…", "jailbreak",
 *   labels de mensaje "system:", "assistant:", "user:").
 *
 * Es una baseline; no bloquea todo (un atacante determinado puede parafrasear),
 * pero corta el 90% del ruido barato. Complementado con:
 * - Escape de `---` en `KnowledgeService.answer` (defensa en profundidad).
 * - System prompt que instruye ignorar instrucciones dentro de fuentes.
 *
 * Regex: `is` = insensible a mayúsculas + dotall. `?!` = look-ahead negativo
 * — el content NO debe contener ninguno de los patrones.
 */
const INJECTION_PATTERN =
  /^(?!.*(--- ?FUENTE|--- ?FIN|ignore (previous|all|above)|olvid[aá] (lo|todo)|desestim[aá]|sos ahora un|actúa como|jailbreak|system:|assistant:|user:))/is;

/**
 * DTO de FaqChunk.
 *
 * NOTA: el schema Prisma actual (ver `prisma/schema.prisma` modelo FaqChunk)
 * expone SÓLO `content` y `embedding` (vector 1536, opcional). No hay `title`.
 * El RAG del Bloque 4 llenará `embedding`; este CRUD sólo maneja `content`.
 *
 * Si el frontend quiere títulos visuales, puede prefijar el `content` con la
 * primera línea (el markdown convencional lo respeta). Cuando el schema evolucione
 * (post-piloto) agregar `title` es una migración menor.
 */
export class CreateFaqDto {
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  @Matches(INJECTION_PATTERN, {
    message: 'contenido con patrones no permitidos',
  })
  content!: string;
}
