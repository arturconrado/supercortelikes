import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { safeOriginalFilename, UploadMetricsTransform, validateAndReplayVideo, VideoTooLargeError } from './video-stream';

const fixtures = {
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('payload')]),
  mov: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypqt  '), Buffer.from('payload')]),
  mkv: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska payload')]),
  avi: Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('AVI '), Buffer.from('payload')]),
};

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('video stream validation', () => {
  it.each([
    ['video.mp4', 'video/mp4', fixtures.mp4, 'mp4'],
    ['video.mov', 'video/quicktime', fixtures.mov, 'mov'],
    ['video.mkv', 'video/x-matroska', fixtures.mkv, 'mkv'],
    ['video.avi', 'video/x-msvideo', fixtures.avi, 'avi'],
  ])('accepts a real %s container', async (filename, mime, bytes, container) => {
    const result = await validateAndReplayVideo(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), filename, mime);
    expect(result.container).toBe(container);
    expect(await read(result.stream)).toEqual(bytes);
  });

  it('rejects extension, MIME and signature spoofing', async () => {
    await expect(validateAndReplayVideo(Readable.from([fixtures.mp4]), 'video.exe', 'video/mp4')).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    await expect(validateAndReplayVideo(Readable.from([fixtures.mp4]), 'video.mp4', 'text/plain')).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    await expect(
      validateAndReplayVideo(Readable.from([Buffer.from('not a video')]), 'video.mp4', 'video/mp4'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('removes paths and control characters from display filenames', () => {
    expect(safeOriginalFilename('../../folder/evil\r\n.mp4')).toBe('evil.mp4');
    expect(safeOriginalFilename('..\\..\\movie.mkv')).toBe('movie.mkv');
  });
});

describe('UploadMetricsTransform', () => {
  it('counts bytes and computes SHA-256 incrementally', async () => {
    const input = Buffer.from('streamed bytes');
    const transform = new UploadMetricsTransform(100n);
    await pipeline(Readable.from([input.subarray(0, 4), input.subarray(4)]), transform, new Writable({ write: (_c, _e, cb) => cb() }));
    expect(transform.bytes()).toBe(BigInt(input.length));
    expect(transform.digest()).toBe(createHash('sha256').update(input).digest('hex'));
  });

  it('accepts exactly the limit and rejects one byte above it', async () => {
    const exact = new UploadMetricsTransform(4n);
    await pipeline(Readable.from([Buffer.alloc(4)]), exact, new Writable({ write: (_c, _e, cb) => cb() }));
    expect(exact.bytes()).toBe(4n);

    const tooLarge = new UploadMetricsTransform(4n);
    await expect(
      pipeline(Readable.from([Buffer.alloc(5)]), tooLarge, new Writable({ write: (_c, _e, cb) => cb() })),
    ).rejects.toBeInstanceOf(VideoTooLargeError);
  });
});
