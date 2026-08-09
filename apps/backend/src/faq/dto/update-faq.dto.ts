import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Mismo regex anti-injection que `CreateFaqDto`. Ver justificación allí.
 * Repetido acá porque `PartialType` no está importado — mantener ambos DTOs
 * standalone hace explícito que el update también valida.
 */
const INJECTION_PATTERN =
  /^(?!.*(--- ?FUENTE|--- ?FIN|ignore (previous|all|above)|olvid[aá] (lo|todo)|desestim[aá]|sos ahora un|actúa como|jailbreak|system:|assistant:|user:))/is;

export class UpdateFaqDto {
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  @Matches(INJECTION_PATTERN, {
    message: 'contenido con patrones no permitidos',
  })
  content?: string;
}
