import { IsBoolean, IsHexColor, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @Length(2, 80)
  name!: string;
}

export class NotificationsDto {
  @IsBoolean() processing!: boolean;
  @IsBoolean() exports!: boolean;
  @IsBoolean() billing!: boolean;
  @IsBoolean() product!: boolean;
}

export class BrandKitDto {
  @IsString() @Length(1, 80) name!: string;
  @IsHexColor() primaryColor!: string;
  @IsOptional() @IsHexColor() accentColor?: string;
  @IsOptional() @IsString() @MaxLength(120) fontFamily?: string;
  @IsOptional() @IsString() @MaxLength(80) watermarkText?: string;
}

export class BrandLogoDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  logoKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  watermarkText?: string;

  @IsOptional()
  @IsIn(['32:32', 'W-w-32:32', '32:H-h-32', 'W-w-32:H-h-32', 'W-tw-32:H-th-32'])
  position?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(1)
  opacity?: number;
}

export class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString()
  @Length(12, 128)
  @Matches(/[a-z]/)
  @Matches(/[A-Z]/)
  @Matches(/[0-9]/)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @IsString() email!: string;
}

export class ResetPasswordDto {
  @IsString() token!: string;
  @IsString()
  @Length(12, 128)
  @Matches(/[a-z]/)
  @Matches(/[A-Z]/)
  @Matches(/[0-9]/)
  password!: string;
}
