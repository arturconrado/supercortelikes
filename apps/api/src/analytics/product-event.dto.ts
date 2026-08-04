import { Type } from 'class-transformer';
import { IsISO8601, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export const PRODUCT_EVENT_NAMES = [
  'signup_completed',
  'login_completed',
  'upload_started',
  'upload_succeeded',
  'upload_failed',
  'upload_cancelled',
  'import_started',
  'import_succeeded',
  'import_failed',
  'project_created',
  'pipeline_retried',
  'preview_opened',
  'editor_saved',
  'export_started',
  'export_succeeded',
  'export_failed',
  'export_downloaded',
  'settings_saved',
  'logout_completed',
] as const;

export class ProductEventDto {
  @IsUUID('4')
  eventId!: string;

  @IsUUID('4')
  sessionId!: string;

  @IsIn(PRODUCT_EVENT_NAMES)
  name!: typeof PRODUCT_EVENT_NAMES[number];

  @IsOptional()
  @IsString()
  @MaxLength(240)
  @Matches(/^\//)
  route?: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  properties?: Record<string, unknown>;
}
