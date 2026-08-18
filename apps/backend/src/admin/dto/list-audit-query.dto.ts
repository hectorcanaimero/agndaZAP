import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AdminAction } from '@prisma/client';

/**
 * Query params para `GET /api/admin/audit`.
 *
 * Todos los filtros son opcionales y aditivos (AND). Si se omiten devuelve
 * el trail completo paginado, más reciente primero.
 *
 * pageSize cap = 200 (alineado con `AdminAuditService.list`).
 */
export class ListAuditQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(36)
  actorUserId?: string;

  @IsOptional()
  @IsEnum(AdminAction, {
    message: `action debe ser uno de: ${Object.values(AdminAction).join(', ')}`,
  })
  action?: AdminAction;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  targetId?: string;

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
  @Max(200, { message: 'pageSize máximo 200' })
  pageSize?: number;
}
