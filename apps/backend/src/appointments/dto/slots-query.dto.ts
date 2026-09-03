import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Query params de `GET /api/appointments/slots`.
 *
 * `days` se valida y luego el controller lo clampea a 30 para limitar costo.
 */
export class SlotsQueryDto {
  @IsString()
  @MaxLength(80)
  serviceId!: string;

  @IsString()
  @MaxLength(80)
  professionalId!: string;

  @IsISO8601()
  from!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  excludeAppointmentId?: string;
}
