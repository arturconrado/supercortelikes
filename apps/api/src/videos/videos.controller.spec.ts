import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { Environment } from '../config/env';
import { VideosController } from './videos.controller';

const user: AuthenticatedUser = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'owner@clipbr.test',
};

function fixture(uploadMode: Environment['UPLOAD_MODE'] = 'direct') {
  const uploads = { upload: vi.fn(), get: vi.fn(), updateTitle: vi.fn().mockResolvedValue({ id: 'video-1', title: 'Novo título' }) };
  const imports = { import: vi.fn().mockResolvedValue({ id: 'video-1', status: 'UPLOADED' }) };
  const direct = { create: vi.fn(), partUrls: vi.fn(), confirm: vi.fn(), abort: vi.fn(), remove: vi.fn() };
  const config = new ConfigService<Environment, true>({ UPLOAD_MODE: uploadMode } as Environment);
  return {
    controller: new VideosController(uploads as never, imports as never, direct as never, config),
    uploads,
    imports,
  };
}

describe('VideosController', () => {
  it('allows YouTube imports when direct upload mode is active', async () => {
    const { controller, imports } = fixture('direct');
    const url = 'https://www.youtube.com/watch?v=VYDE529RzNk';

    await expect(controller.importVideo({ url }, 'yt-import-1234', user)).resolves.toMatchObject({
      id: 'video-1',
      status: 'UPLOADED',
    });

    expect(imports.import).toHaveBeenCalledWith(url, 'yt-import-1234', user, undefined, undefined);
  });

  it('continues blocking the legacy streamed upload when direct upload mode is active', async () => {
    const { controller, uploads } = fixture('direct');
    const request = { isMultipart: () => true } as never;
    const reply = { header: vi.fn() } as never;

    await expect(controller.upload(request, reply, 'stream-upload-1234', undefined, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(uploads.upload).not.toHaveBeenCalled();
  });

  it('renames a tenant-owned video', async () => {
    const { controller, uploads } = fixture('direct');

    await expect(controller.update('33333333-3333-4333-8333-333333333333', { title: 'Novo título' }, user))
      .resolves.toMatchObject({ title: 'Novo título' });

    expect(uploads.updateTitle).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333',
      user.workspaceId,
      'Novo título',
    );
  });
});
