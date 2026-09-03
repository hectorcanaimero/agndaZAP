import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query params de `GET /api/business-hours`.
 *
 * Si `professionalId` viene, el controller valida que pertenezca al tenant y
 * devuelve el horario efectivo: horario propio si existe, si no el horario de
 * clínica (`professionalId = null`).
 */
export class ListBusinessHoursQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  professionalId?: string;
}
