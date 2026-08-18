import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';
import { ClinicStatus } from '@prisma/client';

/**
 * Query params para `GET /api/admin/clinics`.
 *
 * `page`/`pageSize` se transforman a number porque los query strings llegan
 * siempre como string desde Express — mismo patrón que `ListLeadsDto`.
 */
export class ListClinicsQueryDto {
  @IsOptional()
  @IsEnum(ClinicStatus, {
    message: 'status debe ser uno de: ACTIVE, SUSPENDED, ARCHIVED',
  })
  status?: ClinicStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un entero' })
  @Min(1, { message: 'page debe ser ≥ 1' })
  page?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt({ message: 'pageSize debe ser un entero' })
  @Min(1, { message: 'pageSize debe ser ≥ 1' })
  @Max(100, { message: 'pageSize máximo 100' })
  pageSize?: number;
}
