import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, ArrayMaxSize } from 'class-validator';

export const SOCIAL_PROVIDERS = ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS', 'LINKEDIN'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export class CreatePublicationDto {
  @IsUUID('4')
  clipId!: string;

  @IsIn(SOCIAL_PROVIDERS)
  provider!: SocialProvider;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  hashtags?: string[];
}

export class StartSocialConnectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  redirectUri?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  scopes?: string[];
}
