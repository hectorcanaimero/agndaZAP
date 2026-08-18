import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Sub-DTO del primer CLINIC_ADMIN. Se crea junto con la clínica para
 * que el tenant nunca quede sin usuario operador desde el primer segundo.
 *
 * NO acepta password: el backend genera una password random (nunca
 * revelada), crea una Invitation de 7 días y envía email al `email`
 * indicado con link `/invite/{token}` para que el propio usuario elija
 * su contraseña. Ver ADR 0014 (fase 2 — invitation flow).
 */
export class CreateClinicAdminDto {
  @IsEmail({}, { message: 'admin.email debe ser un email válido' })
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'admin.name es obligatorio' })
  @MaxLength(120)
  name!: string;
}

/**
 * Body para `POST /api/admin/clinics`.
 *
 * `wahaSession` es el nombre único de la instancia WAHA —
 * se valida unicidad a nivel DB (unique constraint en schema).
 */
export class CreateClinicDto {
  @IsString()
  @IsNotEmpty({ message: 'name es obligatorio' })
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'slug es obligatorio' })
  @MaxLength(60)
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @IsString()
  @IsNotEmpty({ message: 'wahaSession es obligatorio' })
  @MaxLength(120)
  wahaSession!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @ValidateNested()
  @Type(() => CreateClinicAdminDto)
  admin!: CreateClinicAdminDto;
}
