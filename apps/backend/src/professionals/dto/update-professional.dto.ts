import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ProfessionalProfileFieldsDto } from './professional-profile-fields.dto';

export class UpdateProfessionalDto extends ProfessionalProfileFieldsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  serviceIds?: string[];

  // Follow-up post-atención (ver ADR 0012). El operador prende el flag
  // cuando quiere que este profesional pida feedback al paciente, y elige
  // cuántas horas después de ATENDIDA se manda el mensaje.
  @IsOptional()
  @IsBoolean()
  followUpEnabled?: boolean;

  // Rango pragmático: 0 (inmediato, útil para testing) hasta 168h (7 días).
  // Fuera de ese rango probablemente el paciente ya no recuerde la visita.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(168)
  followUpDelayHours?: number;
}
