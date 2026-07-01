import { IsString, Length } from 'class-validator';

export class UpdateVideoDto {
  @IsString()
  @Length(1, 180)
  title!: string;
}
