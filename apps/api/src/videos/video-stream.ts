import { createHash, type Hash } from 'node:crypto';
import { extname } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { UnsupportedMediaTypeException } from '@nestjs/common';

const acceptedMimeTypes: Record<string, ReadonlySet<string>> = {
  mp4: new Set(['video/mp4', 'application/octet-stream']),
  mov: new Set(['video/quicktime', 'application/octet-stream']),
  mkv: new Set(['video/x-matroska', 'video/matroska', 'application/octet-stream']),
  webm: new Set(['video/webm', 'application/octet-stream']),
  avi: new Set(['video/x-msvideo', 'video/avi', 'application/octet-stream']),
};

export class VideoTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Video exceeds the ${limit} byte limit`);
    this.name = 'VideoTooLargeError';
  }
}

export class UploadMetricsTransform extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private total = 0n;
  private completed = false;

  constructor(private readonly maxBytes: bigint) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.total += BigInt(chunk.length);
    if (this.total > this.maxBytes) {
      callback(new VideoTooLargeError(Number(this.maxBytes)));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.completed = true;
    callback();
  }

  bytes(): bigint {
    return this.total;
  }

  digest(): string {
    if (!this.completed) throw new Error('Cannot read checksum before the stream has completed');
    return this.hash.digest('hex');
  }
}

function isIsoBaseMedia(header: Buffer): boolean {
  return header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp';
}

function isMatroska(header: Buffer): boolean {
  return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function isAvi(header: Buffer): boolean {
  return (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'AVI '
  );
}

function hasMatchingSignature(container: string, header: Buffer): boolean {
  if (container === 'mp4' || container === 'mov') return isIsoBaseMedia(header);
  if (container === 'mkv' || container === 'webm') return isMatroska(header);
  return container === 'avi' && isAvi(header);
}

export function safeOriginalFilename(value: string): string {
  const basename = value.replaceAll('\\', '/').split('/').at(-1) ?? 'video';
  const clean = basename.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return (clean || 'video').slice(0, 255);
}

export async function validateAndReplayVideo(
  input: Readable,
  filename: string,
  mimeType: string,
): Promise<{ stream: Readable; container: string; mimeType: string }> {
  const container = extname(filename).slice(1).toLowerCase();
  const allowedMimes = acceptedMimeTypes[container];
  if (!allowedMimes || !allowedMimes.has(mimeType.toLowerCase())) {
    throw new UnsupportedMediaTypeException('Only MP4, MOV, WEBM, MKV and AVI videos are accepted');
  }

  const iterator = input[Symbol.asyncIterator]();
  const initialChunks: Buffer[] = [];
  let headerLength = 0;
  while (headerLength < 12) {
    const item = await iterator.next();
    if (item.done) break;
    const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value as Uint8Array);
    initialChunks.push(chunk);
    headerLength += chunk.length;
  }
  const header = Buffer.concat(initialChunks, headerLength);
  if (!hasMatchingSignature(container, header)) {
    await iterator.return?.();
    throw new UnsupportedMediaTypeException('The file content does not match a supported video container');
  }

  async function* replay(): AsyncGenerator<Buffer> {
    try {
      yield* initialChunks;
      while (true) {
        const item = await iterator.next();
        if (item.done) return;
        yield Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value as Uint8Array);
      }
    } finally {
      await iterator.return?.();
    }
  }

  return { stream: Readable.from(replay()), container, mimeType: mimeType.toLowerCase() };
}
