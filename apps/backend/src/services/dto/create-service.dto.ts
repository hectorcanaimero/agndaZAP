import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * DTO de creación de servicio (panel — CLINIC_ADMIN/SUPERADMIN).
 *
 * `clinicId` NO se acepta del body: se resuelve desde el JWT vía TenantContext.
 * Esto es intencional para no permitir crear en otra clínica desde un JWT ajeno.
 */
export class CreateServiceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsInt()
  @Min(5)
  durationMin!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bufferMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  professionalIds?: string[];
}
