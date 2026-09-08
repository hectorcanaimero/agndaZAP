import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { stripControlChars } from '../../common/sanitize-text';

export class UpdateTimeOffDto {
  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? stripControlChars(value) : value,
  )
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsString()
  professionalId?: string;
}
