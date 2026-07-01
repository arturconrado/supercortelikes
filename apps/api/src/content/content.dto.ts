import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

export class UpdateClipDto {
  @IsOptional()
  @IsString()
  @Length(1, 180)
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

  @IsOptional()
  @IsIn(['9:16', '1:1', '4:5', '16:9'])
  aspectRatio?: string;

  @IsOptional()
  @IsIn(['SUGGESTED', 'APPROVED'])
  status?: 'SUGGESTED' | 'APPROVED';
}

export class UpdateClipTimingDto {
  @IsNumber()
  @Min(0)
  startSeconds!: number;

  @IsNumber()
  @Min(0.1)
  @Max(24 * 60 * 60)
  endSeconds!: number;
}

export class UpdateClipCaptionsDto {
  @IsArray()
  @ArrayMaxSize(5_000)
  cues!: unknown[];

  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  template?: string;

  @IsOptional()
  @IsObject()
  style?: Record<string, unknown>;
}

export class RenderClipDto {
  @IsOptional()
  @IsIn(['9:16', '1:1', '4:5', '16:9'])
  aspectRatio?: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ClipExportDto {
  @IsOptional()
  @IsIn(['MP4'])
  format?: string;

  @IsOptional()
  @IsIn(['9:16', '1:1', '4:5', '16:9'])
  aspectRatio?: string;
}
