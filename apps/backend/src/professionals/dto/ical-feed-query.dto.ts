import { IsString, MaxLength, MinLength } from 'class-validator';

/** Query params del feed iCal público. */
export class IcalFeedQueryDto {
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  token!: string;
}
