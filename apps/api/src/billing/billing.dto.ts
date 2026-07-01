import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CheckoutDto {
  @Transform(({ value, obj }: { value: unknown; obj: { planId?: unknown } }) => value ?? obj.planId)
  @IsIn(['PRO', 'BUSINESS'])
  plan!: 'PRO' | 'BUSINESS';

  @IsIn(['PIX', 'CARD'])
  method!: 'PIX' | 'CARD';

  @IsOptional()
  @IsString()
  @Length(11, 14)
  document?: string;
}

export class TopUpDto {
  @IsInt()
  @Min(60)
  @Max(2_000)
  minutes!: number;

  @IsOptional()
  @IsIn(['PIX', 'CARD'])
  method?: 'PIX' | 'CARD';

  @IsOptional()
  @IsString()
  @Length(11, 14)
  document?: string;
}
