import { IsString, Length } from 'class-validator';

export class DeleteAccountDto {
  @IsString()
  @Length(12, 128)
  password!: string;
}
