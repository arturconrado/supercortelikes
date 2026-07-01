import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';

const size = Number(process.env.ACCEPTANCE_SIZE_BYTES);
const target = new URL(process.env.ACCEPTANCE_API_URL ?? 'http://localhost:3001/videos/upload');
const accessToken = process.env.ACCEPTANCE_ACCESS_TOKEN;
if (!Number.isSafeInteger(size) || size < 12) {
  throw new Error('ACCEPTANCE_SIZE_BYTES must be a safe integer greater than or equal to 12');
}

const boundary = `clipbr-${randomUUID()}`;
const idempotencyKey = `acceptance-${randomUUID()}`;
const preamble = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="acceptance.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
);
const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
const fileHeader = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]);
const zeroChunk = Buffer.allocUnsafe(8 * 1024 * 1024).fill(0);
const checksum = createHash('sha256');

const response = await new Promise((resolve, reject) => {
  const req = request(
    target,
    {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': idempotencyKey,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
    },
    (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    },
  );
  req.on('error', reject);

  const send = async (chunk) => {
    if (!req.write(chunk)) await new Promise((drain) => req.once('drain', drain));
  };

  void (async () => {
    try {
      await send(preamble);
      checksum.update(fileHeader);
      await send(fileHeader);
      let remaining = size - fileHeader.length;
      while (remaining > 0) {
        const chunk = remaining >= zeroChunk.length ? zeroChunk : zeroChunk.subarray(0, remaining);
        checksum.update(chunk);
        await send(chunk);
        remaining -= chunk.length;
      }
      await send(epilogue);
      req.end();
    } catch (error) {
      req.destroy(error);
    }
  })();
});

if (response.statusCode !== 201) {
  throw new Error(`Upload failed with HTTP ${response.statusCode}: ${response.body}`);
}
const video = JSON.parse(response.body);
const expectedChecksum = checksum.digest('hex');
if (video.sizeBytes !== String(size)) throw new Error(`Expected ${size} bytes, received ${video.sizeBytes}`);
if (video.checksumSha256 !== expectedChecksum) throw new Error('The API checksum does not match the generated stream');
if (video.status !== 'UPLOADED') throw new Error(`Expected UPLOADED, received ${video.status}`);

process.stdout.write(
  `${JSON.stringify({ id: video.id, status: video.status, sizeBytes: video.sizeBytes, checksumSha256: video.checksumSha256 })}\n`,
);
