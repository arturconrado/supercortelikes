import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { VideoProcessingOptionsDto } from './video-processing-options.dto';

export class PresignedUploadDto {
  @IsString()
  @Length(1, 255)
  filename!: string;

  @IsString()
  @MaxLength(120)
  mimeType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @IsOptional()
  @IsUUID('4')
  projectId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VideoProcessingOptionsDto)
  processingOptions?: VideoProcessingOptionsDto;
}

export class UploadPartsDto {
  @IsString()
  @Length(1, 2048)
  uploadId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  partNumbers!: number[];
}

export class CompletedPartDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  partNumber!: number;

  @IsString()
  @Length(1, 256)
  etag!: string;
}

export class ConfirmUploadDto {
  @IsUUID('4')
  videoId!: string;

  @IsString()
  @Length(1, 2048)
  uploadId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts!: CompletedPartDto[];
}
