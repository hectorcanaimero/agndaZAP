import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  Logger,
  PipeTransform,
} from '@nestjs/common';

/**
 * Regex del slug: minúsculas, dígitos y guión. 1..50 chars.
 *
 * Ancla en `^…$` para forzar match total (evitar substrings). No permitimos
 * `_`, `.` ni mayúsculas — el slug es URL-safe y case-insensitive por
 * convención (el store normaliza a minúsculas en el seed).
 */
const SLUG_REGEX = /^[a-z0-9-]{1,50}$/;

/**
 * Pipe de validación del `@Param('slug')` en el `PublicController`.
 *
 * Defensa en profundidad:
 * - El endpoint es público y sin auth → cualquiera puede pegarle URLs raras.
 * - Prisma se banca strings arbitrarios en `where: { slug }`, pero validar
 *   temprano evita queries innecesarias y filtra intentos de path/log injection.
 * - **Cero PII en logs**: sólo logueamos el status 400. NUNCA el valor recibido
 *   (podría contener basura del atacante que ensucie logs).
 */
@Injectable()
export class SlugValidationPipe implements PipeTransform<string, string> {
  private readonly logger = new Logger('SlugValidationPipe');

  transform(value: string, _metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !SLUG_REGEX.test(value)) {
      // NO logueamos `value` — sólo status. Ver docstring de la clase.
      this.logger.warn('slug inválido rechazado status=400');
      throw new BadRequestException('slug inválido');
    }
    return value;
  }
}
