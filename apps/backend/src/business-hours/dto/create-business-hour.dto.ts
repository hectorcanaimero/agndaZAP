import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * DTO de BusinessHour. Los minutos son desde medianoche (ej: 540 = 09:00).
 * `weekday`: 0=domingo ... 6=sábado (coincide con la lógica de AvailabilityService).
 * `professionalId` opcional: si null, aplica a toda la clínica.
 */
export class CreateBusinessHourDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @IsInt()
  @Min(0)
  @Max(1440)
  startMinutes!: number;

  @IsInt()
  @Min(0)
  @Max(1440)
  endMinutes!: number;

  @IsOptional()
  @IsString()
  professionalId?: string;
}
