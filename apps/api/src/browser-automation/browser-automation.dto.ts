import { IsIn, IsOptional, IsString, IsUrl, IsUUID, Length, MaxLength } from 'class-validator';

export class BrowserResearchDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(1000)
  targetUrl!: string;

  @IsString()
  @Length(8, 500)
  goal!: string;

  @IsOptional()
  @IsUUID('4')
  opportunityId?: string;

  @IsOptional()
  @IsIn(['MARKET_RESEARCH', 'COMPETITOR_REVIEW', 'CUSTOM'])
  kind?: 'MARKET_RESEARCH' | 'COMPETITOR_REVIEW' | 'CUSTOM';
}
