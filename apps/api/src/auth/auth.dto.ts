import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RegisterDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(({ value, obj }: { value: unknown; obj: { name?: unknown } }) => value ?? obj.name)
  @IsString()
  @Length(2, 80)
  displayName!: string;

  @IsString()
  @Length(12, 128)
  @Matches(/[a-z]/, { message: 'password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password!: string;

  @IsString()
  @Length(1, 80)
  acceptedTermsVersion!: string;

  @IsString()
  @Length(1, 80)
  acceptedPrivacyVersion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2048)
  turnstileToken?: string;
}

export class LoginDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshDto {
  @IsString()
  @Length(32, 256)
  refreshToken!: string;
}

export class VerifyEmailDto {
  @IsString()
  @Length(32, 256)
  token!: string;
}

export class RequestEmailVerificationDto {
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  turnstileToken?: string;
}

export class ForgotPasswordDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2048)
  turnstileToken?: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(32, 256)
  token!: string;

  @IsString()
  @Length(12, 128)
  @Matches(/[a-z]/, { message: 'password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password!: string;
}
