import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTimeOffDto {
  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsString()
  professionalId?: string;
}
