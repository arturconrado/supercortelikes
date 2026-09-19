import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUrl, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class OpportunitySignalDto {
  @IsString()
  @Length(2, 80)
  source!: string;

  @IsString()
  @Length(3, 180)
  label!: string;

  @IsInt()
  @Min(0)
  @Max(100)
  strength!: number;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  url?: string;
}

export class CreateOpportunityDto {
  @IsString()
  @Length(3, 160)
  title!: string;

  @IsString()
  @Length(3, 160)
  audience!: string;

  @IsString()
  @Length(8, 500)
  pain!: string;

  @IsString()
  @Length(2, 80)
  category!: string;

  @IsString()
  @Length(2, 80)
  format!: string;

  @IsOptional()
  @IsIn(['PRODUCT', 'SERVICE', 'HYBRID'])
  offerType?: 'PRODUCT' | 'SERVICE' | 'HYBRID';

  @IsInt()
  @Min(0)
  @Max(100)
  demandScore!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  saturationScore!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  monetizationScore!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  channelFitScore!: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpportunitySignalDto)
  signals?: OpportunitySignalDto[];
}

export class ScoutOpportunitiesDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  theme?: string;
}

export class DecideOpportunityDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';
}

export class AdvanceOpportunityDto {
  @IsIn(['OBSERVING', 'TESTING', 'ACTIVE', 'SCALING', 'DECLINING', 'MIGRATING', 'DEAD'])
  status!: 'OBSERVING' | 'TESTING' | 'ACTIVE' | 'SCALING' | 'DECLINING' | 'MIGRATING' | 'DEAD';
}

export class UpdateMediaAssetStatusDto {
  @IsIn(['DRAFT', 'READY', 'REVIEW_REQUIRED', 'APPROVED', 'ARCHIVED'])
  status!: 'DRAFT' | 'READY' | 'REVIEW_REQUIRED' | 'APPROVED' | 'ARCHIVED';
}

export class CreateMetricSnapshotDto {
  @IsString()
  @Length(2, 80)
  source!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  impressions?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  clicks?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  leads?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sales?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  revenueCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  costCents?: number;
}
