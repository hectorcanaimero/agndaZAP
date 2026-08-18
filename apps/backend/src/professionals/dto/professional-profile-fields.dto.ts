import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsHexColor,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Campos de perfil comunes a create y update. Se mezclan con las clases
 * concretas via `extends` para no duplicar validaciones.
 *
 * TODOS son opcionales — hoy solo `name` es requerido (viene en las clases
 * concretas). El resto se puede completar después desde el detalle.
 */
export class ProfessionalProfileFieldsDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsEmail({}, { message: 'email inválido' })
  @MaxLength(200)
  email?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone debe estar en formato E.164 (ej: +5491135551234)',
  })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsUrl({ require_protocol: true }, { message: 'avatarUrl debe ser una URL válida (http/https)' })
  @MaxLength(500)
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  licenseNumber?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsHexColor({ message: 'color debe ser hex (ej: #3b82f6)' })
  color?: string;
}
