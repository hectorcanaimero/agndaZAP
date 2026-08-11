import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * DTO del endpoint público de captura de leads (landing → CTA).
 *
 * Mismas reglas de higiene que `CreatePublicAppointmentDto`:
 * - `phone` en E.164 con o sin `+` inicial. La normalización final vive en el
 *   controller (idéntico al de agendamiento) para mantener un solo lugar de
 *   canonicalización.
 * - `consent` DEBE ser `true` (LGPD/ARCO — el usuario acepta ser contactado).
 * - `honeypot` opcional: si viene con valor, el controller responde 200 SIN
 *   persistir. No lo señalizamos al bot vía 400.
 * - `clinicType` es opcional y validado contra whitelist para que aunque un
 *   cliente hostil mande basura, sólo aceptemos valores conocidos.
 * - `locale` es 'es' | 'pt'. Se usa para eventual follow-up en el idioma
 *   correcto (por WhatsApp).
 */
const ALLOWED_CLINIC_TYPES = [
  'consultorio',
  'clinica',
  'estetica',
  'especialista',
  'otro',
] as const;

const ALLOWED_LOCALES = ['es', 'pt'] as const;

export class CreateLeadDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  /** E.164 con o sin `+` inicial. Longitud 8–15. */
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone debe estar en formato E.164 (ej: +584141234567)',
  })
  phone!: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_CLINIC_TYPES as unknown as string[])
  clinicType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsBoolean()
  @Equals(true, { message: 'consent debe ser true' })
  consent!: boolean;

  @IsString()
  @IsIn(ALLOWED_LOCALES as unknown as string[])
  locale!: string;

  /**
   * Honeypot invisible en el frontend. Ver DTO de agendamiento público para
   * la justificación completa.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  honeypot?: string;
}
