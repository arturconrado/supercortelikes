import { PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand, S3Client } from '@aws-sdk/client-s3';

const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
const origins = (process.env.R2_CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((value) => value.trim()).filter(Boolean);
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'auto',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
await client.send(new PutBucketCorsCommand({
  Bucket: process.env.S3_BUCKET,
  CORSConfiguration: {
    CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }],
  },
}));
await client.send(new PutBucketLifecycleConfigurationCommand({
  Bucket: process.env.S3_BUCKET,
  LifecycleConfiguration: {
    Rules: [{ ID: 'abort-incomplete-multipart', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }],
  },
}));
process.stdout.write(`${JSON.stringify({ status: 'configured', bucket: process.env.S3_BUCKET, origins })}\n`);
