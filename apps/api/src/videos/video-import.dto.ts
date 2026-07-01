import { Type } from 'class-transformer';
import { IsOptional, IsUrl, IsUUID, ValidateNested } from 'class-validator';
import { VideoProcessingOptionsDto } from './video-processing-options.dto';

export class ImportVideoDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;

  @IsOptional()
  @IsUUID('4')
  projectId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VideoProcessingOptionsDto)
  processingOptions?: VideoProcessingOptionsDto;
}
