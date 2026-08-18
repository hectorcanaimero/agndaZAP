import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Query params de `GET /api/patients`.
 *
 * `q` matchea case-insensitive en `name` y `phone` (Prisma `contains` con
 * `mode: 'insensitive'`). NO usa vector search — con la cantidad esperada
 * por clínica (100s-1000s de pacientes), ILIKE es más que suficiente.
 */
export class ListPatientsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;
}
