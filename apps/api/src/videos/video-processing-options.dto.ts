import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  CLIP_ASPECT_RATIOS,
  CLIP_DURATION_PRESETS,
  CLIP_TARGET_PLATFORMS,
  type ClipAspectRatio,
  type ClipDurationPreset,
  type ClipTargetPlatform,
} from './video-processing-options';

export class VideoProcessingOptionsDto {
  @IsOptional()
  @IsIn(CLIP_DURATION_PRESETS)
  durationPreset?: ClipDurationPreset;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  minimumDurationSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  maximumDurationSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  clipCount?: number;

  @IsOptional()
  @IsIn(CLIP_ASPECT_RATIOS)
  aspectRatio?: ClipAspectRatio;

  @IsOptional()
  @IsIn(CLIP_TARGET_PLATFORMS)
  targetPlatform?: ClipTargetPlatform;
}
