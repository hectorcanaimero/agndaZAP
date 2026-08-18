import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body para `PATCH /api/admin/clinics/:id`.
 *
 * Todos los campos son opcionales — partial update. Nunca exponemos
 * `slug`, `wahaSession` ni `status` aquí: el slug es inmutable post-creación
 * (rompe URLs externas) y el status se gestiona vía `/suspend` y `/reactivate`.
 */
export class UpdateClinicDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;
}
