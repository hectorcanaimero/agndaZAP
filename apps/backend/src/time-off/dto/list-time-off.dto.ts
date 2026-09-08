import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Query params de `GET /api/time-off`. */
export class ListTimeOffQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  professionalId?: string;
}
