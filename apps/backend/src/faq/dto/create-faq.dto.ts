import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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
 * Schema: `title` (opcional, max 200) + `content` (markdown crudo, 5..4000
 * chars con guarda anti-injection) + `embedding` (vector 1536, lo llena el
 * `KnowledgeService`).
 *
 * `title` es opcional para no forzar migraciones de datos viejos y porque el
 * bot no necesita título — sólo el content va al vector. La UI de la "Base de
 * conocimiento" lo usa como etiqueta en la lista (ver ADR 0009).
 */
export class CreateFaqDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  @Matches(INJECTION_PATTERN, {
    message: 'contenido con patrones no permitidos',
  })
  content!: string;
}
