import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Body,
  Delete,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { VideoResponseDto } from './video-response.dto';
import { VideoUploadService } from './video-upload.service';
import { VideoImportService } from './video-import.service';
import { ImportVideoDto } from './video-import.dto';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/env';
import { ConfirmUploadDto, PresignedUploadDto, UploadPartsDto } from './direct-upload.dto';
import { DirectUploadService } from './direct-upload.service';
import { UpdateVideoDto } from './video-update.dto';

@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploads: VideoUploadService,
    private readonly imports: VideoImportService,
    private readonly direct: DirectUploadService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post('presigned-upload')
  @HttpCode(HttpStatus.CREATED)
  async presignedUpload(
    @Body() input: PresignedUploadDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return this.direct.create(input, idempotencyKey, user);
  }

  @Post(':id/upload-parts')
  async uploadParts(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UploadPartsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.direct.partUrls(id, input, user);
  }

  @Post('confirm-upload')
  async confirmUpload(@Body() input: ConfirmUploadDto, @CurrentUser() user: AuthenticatedUser) {
    return this.direct.confirm(input, user);
  }

  @Post('import')
  async importVideo(
    @Body() input: ImportVideoDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoResponseDto> {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return this.imports.import(input.url, idempotencyKey, user, input.projectId, input.processingOptions);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  async abortUpload(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.direct.abort(id, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.direct.remove(id, user);
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateVideoDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoResponseDto> {
    return this.uploads.updateTitle(id, user.workspaceId, input.title);
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-project-id') projectId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<VideoResponseDto> {
    if (this.config.get('UPLOAD_MODE', { infer: true }) === 'direct') {
      throw new BadRequestException('Streamed uploads are disabled; request a presigned multipart upload');
    }
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    if (!request.isMultipart()) throw new BadRequestException('Content-Type must be multipart/form-data');
    const file = await request.file();
    if (!file) throw new BadRequestException('Multipart field "file" is required');
    if (file.fieldname !== 'file') throw new BadRequestException('The uploaded file must use the field name "file"');
    if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new BadRequestException('X-Project-Id must be a UUID v4');
    }
    const video = await this.uploads.upload(
      { filename: file.filename, mimetype: file.mimetype, stream: file.file },
      idempotencyKey,
      user,
      projectId,
    );
    reply.header('Location', `/videos/${video.id}`);
    return video;
  }

  @Get(':id')
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<VideoResponseDto> {
    return this.uploads.get(id, user?.workspaceId);
  }
}
