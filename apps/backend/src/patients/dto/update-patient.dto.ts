import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { stripControlChars } from '../../common/sanitize-text';

/**
 * DTO para `PATCH /api/patients/:id`.
 *
 * NO exponemos `phone` — el phone es el identificador natural del paciente
 * (unique por clinicId). Cambiarlo desde UI es peligroso (rompe correlación
 * con conversaciones/citas). Si un paciente cambia de número, se crea uno
 * nuevo y (follow-up) se ofrece "merge" en un flujo aparte.
 *
 * `consent` sólo se puede prender (nunca apagar desde acá) para no perder
 * evidencia LGPD/GDPR — es un ratchet legal, no un toggle. Si el paciente
 * revoca consent, debería ser un evento aparte con auditoría (post-piloto).
 */
export class UpdatePatientDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? stripControlChars(value) : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}
