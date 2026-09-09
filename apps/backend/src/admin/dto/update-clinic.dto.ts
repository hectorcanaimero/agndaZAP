import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

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

  /**
   * WhatsApp público de la clínica (opt-in) — ver `Clinic.publicWhatsappPhone`.
   * Mismo contrato que `PATCH /api/clinics/me`: se canoniza a E.164 en el
   * service; '' = borrar.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value,
  )
  @ValidateIf((o: { publicWhatsappPhone?: string }) => o.publicWhatsappPhone !== '')
  @Matches(/^(\+|00)?[1-9]\d{7,14}$/, {
    message:
      'publicWhatsappPhone debe ser un número internacional válido (ej. +5804121234567)',
  })
  publicWhatsappPhone?: string;
}
