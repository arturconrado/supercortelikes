import { execSync } from 'node:child_process';

const apiUrl = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
const appUrl = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const durationMinutes = Number(process.env.SOAK_DURATION_MINUTES ?? 24 * 60);
const intervalSeconds = Number(process.env.SOAK_INTERVAL_SECONDS ?? 30 * 60);
const flowCommand = process.env.SOAK_FLOW_COMMAND;
if (!apiUrl || !appUrl) throw new Error('PUBLIC_API_URL and PUBLIC_APP_URL are required');
if (!Number.isFinite(durationMinutes) || !Number.isFinite(intervalSeconds) || durationMinutes <= 0 || intervalSeconds <= 0) {
  throw new Error('SOAK_DURATION_MINUTES and SOAK_INTERVAL_SECONDS must be positive numbers');
}

const startedAt = Date.now();
const deadline = startedAt + durationMinutes * 60 * 1000;
let samples = 0;
let flows = 0;
while (Date.now() < deadline) {
  samples += 1;
  const [ready, pipeline, web] = await Promise.all([
    json(`${apiUrl}/health/ready`),
    json(`${apiUrl}/health/pipeline`),
    fetch(appUrl),
  ]);
  if (ready.status !== 'ok') throw new Error(`API not ready: ${JSON.stringify(ready)}`);
  if (pipeline.deadLettersOpen !== 0) throw new Error(`Open DLQ jobs during soak: ${pipeline.deadLettersOpen}`);
  if ((pipeline.outbox?.unpublished ?? 0) !== 0 && (pipeline.outbox?.oldestAgeMs ?? 0) > 5 * 60 * 1000) {
    throw new Error(`Outbox backlog exceeded 5 minutes: ${JSON.stringify(pipeline.outbox)}`);
  }
  if (!web.ok) throw new Error(`Web returned ${web.status}`);
  if (flowCommand && flows < 3 && shouldRunFlow(samples, durationMinutes, intervalSeconds, flows)) {
    execSync(flowCommand, { stdio: 'inherit', env: process.env });
    flows += 1;
  }
  process.stdout.write(`${JSON.stringify({ sample: samples, ready: ready.status, pipeline: pipeline.status, flows })}\n`);
  const remainingMs = deadline - Date.now();
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalSeconds * 1000, remainingMs)));
}
if (flowCommand && flows < 3) throw new Error(`Expected at least 3 complete flows during soak, executed ${flows}`);
process.stdout.write(`${JSON.stringify({ status: 'PASS', samples, flows, durationMinutes })}\n`);

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function shouldRunFlow(sample, minutes, interval, completed) {
  const expectedSamples = Math.max(1, Math.ceil((minutes * 60) / interval));
  const targets = [1, Math.max(1, Math.floor(expectedSamples / 2)), expectedSamples];
  return sample >= targets[completed];
}
