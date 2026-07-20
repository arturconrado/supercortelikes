import type { Readable } from 'node:stream';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface StoredObject {
  etag?: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface StoredObjectMetadata {
  bytes: bigint;
  contentType?: string;
  etag?: string;
}

export interface DownloadUrlOptions {
  disposition?: 'inline' | 'attachment';
  filename?: string;
  contentType?: string;
}

export interface ObjectStorage {
  ready(): Promise<boolean>;
  createMultipart(key: string, contentType: string): Promise<string>;
  multipartPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds?: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<StoredObject>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  metadata(key: string): Promise<StoredObjectMetadata>;
  upload(key: string, body: Readable, contentType: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  downloadUrl(key: string, expiresInSeconds?: number, options?: DownloadUrlOptions): Promise<string>;
}
