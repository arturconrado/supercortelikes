import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import type { Environment } from '../config/env';
import type { DownloadUrlOptions, MultipartPart, ObjectStorage, StoredObject, StoredObjectMetadata } from './storage.port';

@Injectable()
export class R2StorageService implements ObjectStorage {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;
  private readonly partSize: number;
  private readonly queueSize: number;

  constructor(private readonly config: ConfigService<Environment, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.partSize = config.get('UPLOAD_PART_SIZE_BYTES', { infer: true });
    this.queueSize = config.get('UPLOAD_QUEUE_SIZE', { infer: true });
    const endpoint = config.get('S3_ENDPOINT', { infer: true });
    const clientOptions = {
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    };
    this.client = new S3Client({ ...clientOptions, endpoint });
    this.publicClient = new S3Client({
      ...clientOptions,
      endpoint: config.get('S3_PUBLIC_ENDPOINT', { infer: true }) ?? endpoint,
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    }));
    if (!result.UploadId) throw new Error('Object storage did not return a multipart upload id');
    return result.UploadId;
  }

  async multipartPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: Math.min(3600, Math.max(60, expiresInSeconds)) },
    );
  }

  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<StoredObject> {
    const result = await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }));
    return { etag: result.ETag?.replaceAll('"', '') };
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }

  async metadata(key: string): Promise<StoredObjectMetadata> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return {
      bytes: BigInt(result.ContentLength ?? 0),
      contentType: result.ContentType,
      etag: result.ETag?.replaceAll('"', ''),
    };
  }

  async upload(key: string, body: Readable, contentType: string): Promise<StoredObject> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      partSize: this.partSize,
      queueSize: this.queueSize,
      leavePartsOnError: false,
    });
    const result = await upload.done();
    return { etag: result.ETag?.replaceAll('"', '') };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async downloadUrl(key: string, expiresInSeconds = 900, options: DownloadUrlOptions = {}): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(options.disposition, options.filename),
        ResponseContentType: options.contentType,
      }),
      {
        expiresIn: Math.min(3600, Math.max(60, expiresInSeconds)),
      },
    );
  }
}

function contentDisposition(disposition?: DownloadUrlOptions['disposition'], filename?: string): string | undefined {
  if (!disposition) return undefined;
  if (!filename) return disposition;
  const safe = sanitizeDownloadFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987ValueChars(safe)}`;
}

function sanitizeDownloadFilename(filename: string): string {
  const trimmed = filename
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed || 'picashorts-video.mp4';
}

function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
