import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { stripControlChars } from '../../common/sanitize-text';

/**
 * DTO de TimeOff. `startAt`/`endAt` en ISO 8601. Se parsean con Luxon usando
 * la TZ de la clínica en el controller — DB guarda UTC.
 */
export class CreateTimeOffDto {
  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? stripControlChars(value) : value,
  )
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsString()
  professionalId?: string;
}
