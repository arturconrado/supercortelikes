import { IsIn, IsString, IsUUID } from 'class-validator';

export class CreateExportDto {
  @IsUUID('4')
  clipId!: string;

  @IsString()
  @IsIn(['MP4'])
  format!: string;

  @IsIn(['9:16', '1:1', '4:5', '16:9'])
  aspectRatio!: string;
}
