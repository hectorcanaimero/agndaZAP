import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { LeadStatus } from '@prisma/client';

/**
 * DTO del endpoint del panel `GET /api/leads` — listado paginado con filtro
 * opcional por status.
 *
 * Convenciones:
 * - Page/pageSize son enteros ≥1. Pinneamos `pageSize` a 100 para no permitir
 *   scans grandes desde el navegador (defensa en profundidad — la tabla `Lead`
 *   crece lento pero mejor blindarlo desde ahora).
 * - `status` es opcional y validado contra el enum de Prisma. Si viene algo
 *   distinto de `LeadStatus`, class-validator responde 400.
 * - Los transforms parsean `string → number` porque los query params llegan
 *   siempre como string desde Express. Mantiene el DTO limpio en el controller.
 */
export class ListLeadsDto {
  @IsOptional()
  @IsEnum(LeadStatus, {
    message:
      'status debe ser uno de: NEW, CONTACTED, DEMO, CONVERTED, LOST',
  })
  status?: LeadStatus;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
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
