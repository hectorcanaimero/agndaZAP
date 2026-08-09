import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateBusinessHourDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  startMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  endMinutes?: number;

  @IsOptional()
  @IsString()
  professionalId?: string;
}
