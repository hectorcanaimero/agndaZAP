import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body de `POST /conversations/:id/reply`.
 *
 * `text` es sanitizado: trim + strip de caracteres de control ASCII (0x00-0x1F
 * y 0x7F) salvo `\n` y `\t`. Defensa contra:
 *  - XSS (el panel renderiza en HTML).
 *  - Payloads con control chars raros que pueden romper renderers.
 */
export class ReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1500)
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    // Eliminamos control chars salvo \n (0x0A) y \t (0x09).
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
  })
  text!: string;
}
