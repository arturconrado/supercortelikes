import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aws = vi.hoisted(() => ({
  clients: [] as any[], send: vi.fn(), uploadDone: vi.fn().mockResolvedValue({ ETag: '"etag"' }), signed: vi.fn().mockResolvedValue('http://localhost:9000/signed'),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = aws.send; options: any; constructor(options: any) { this.options = options; aws.clients.push(this); } },
  DeleteObjectCommand: class { constructor(public input: any) {} },
  DeleteObjectsCommand: class { constructor(public input: any) {} },
  GetObjectCommand: class { constructor(public input: any) {} },
  PutObjectCommand: class { constructor(public input: any) {} },
  ListObjectsV2Command: class { constructor(public input: any) {} },
}));
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class { constructor(public options: any) {} done = aws.uploadDone; } }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: aws.signed }));

import { R2StorageService } from '../src/storage/r2-storage.service';

describe('R2StorageService release endpoints', () => {
  beforeEach(() => {
    aws.clients.length = 0;
    aws.send.mockReset();
    aws.uploadDone.mockClear();
    aws.signed.mockReset().mockResolvedValue('http://localhost:9000/signed');
  });

  it('uses the internal endpoint for writes and the public endpoint for signed downloads', async () => {
    const values: Record<string, unknown> = {
      S3_BUCKET: 'clipbr-videos', UPLOAD_PART_SIZE_BYTES: 5 * 1024 * 1024, UPLOAD_QUEUE_SIZE: 2,
      S3_ENDPOINT: 'http://minio:9000', S3_PUBLIC_ENDPOINT: 'http://localhost:9000', S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true, S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret',
    };
    const service = new R2StorageService({ get: (key: string) => values[key] } as any);
    expect(aws.clients[0].options.endpoint).toBe('http://minio:9000');
    expect(aws.clients[1].options.endpoint).toBe('http://localhost:9000');
    expect(await service.upload('videos/source.mp4', Readable.from(Buffer.from('video')), 'video/mp4')).toEqual({ etag: 'etag' });
    await service.delete('videos/source.mp4');
    expect(await service.downloadUrl('exports/clip.mp4', 5000)).toBe('http://localhost:9000/signed');
    expect(aws.signed).toHaveBeenCalledWith(aws.clients[1], expect.anything(), { expiresIn: 3600 });
    expect(await service.downloadUrl('exports/café.mp4', 900, {
      disposition: 'attachment',
      filename: 'Café: corte final.mp4',
      contentType: 'video/mp4',
    })).toBe('http://localhost:9000/signed');
    const signedCommand = aws.signed.mock.calls.at(-1)?.[1] as { input?: Record<string, unknown> };
    expect(signedCommand.input).toMatchObject({
      ResponseContentDisposition: expect.stringContaining('attachment; filename='),
      ResponseContentType: 'video/mp4',
    });
    expect(String(signedCommand.input?.ResponseContentDisposition)).toContain("filename*=UTF-8''Caf%C3%A9-%20corte%20final.mp4");
    expect(await service.uploadUrl('exports/clip.mp4', 'video/mp4', 7200)).toBe('http://localhost:9000/signed');
    expect(aws.signed).toHaveBeenLastCalledWith(aws.clients[1], expect.anything(), { expiresIn: 3600 });
  });

  it('deletes every paginated object under an explicit directory prefix', async () => {
    const values: Record<string, unknown> = {
      S3_BUCKET: 'clipbr-videos', UPLOAD_PART_SIZE_BYTES: 5 * 1024 * 1024, UPLOAD_QUEUE_SIZE: 2,
      S3_ENDPOINT: 'http://minio:9000', S3_PUBLIC_ENDPOINT: 'http://localhost:9000', S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true, S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret',
    };
    const service = new R2StorageService({ get: (key: string) => values[key] } as any);
    aws.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'exports/video/one.mp4' }], IsTruncated: true, NextContinuationToken: 'next' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [{ Key: 'exports/video/two.srt' }], IsTruncated: false })
      .mockResolvedValueOnce({});

    await expect(service.deletePrefix('/exports/video/')).resolves.toBe(2);
    expect(aws.send).toHaveBeenCalledTimes(4);
    await expect(service.deletePrefix('unsafe-object')).rejects.toThrow('directory prefix');
  });
});
