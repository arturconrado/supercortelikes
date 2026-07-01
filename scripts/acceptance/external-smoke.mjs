const apiUrl = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
const appUrl = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const sha = process.env.EXPECTED_SHA;
if (!apiUrl || !appUrl || !sha) throw new Error('PUBLIC_API_URL, PUBLIC_APP_URL and EXPECTED_SHA are required');
const [ready, live, pipeline, web] = await Promise.all([
  fetch(`${apiUrl}/health/ready`),
  fetch(`${apiUrl}/health/live`),
  fetch(`${apiUrl}/health/pipeline`),
  fetch(appUrl),
]);
if (!ready.ok || !live.ok || !pipeline.ok || !web.ok) {
  throw new Error(`Smoke failed: ready=${ready.status}, live=${live.status}, pipeline=${pipeline.status}, web=${web.status}`);
}
const liveBody = await live.json();
if (liveBody.build !== sha) throw new Error(`Expected API build ${sha}, received ${liveBody.build}`);
const pipelineBody = await pipeline.json();
if (pipelineBody.deadLettersOpen !== 0) throw new Error(`Expected zero open DLQ jobs, received ${pipelineBody.deadLettersOpen}`);
if (pipelineBody.outbox?.unpublished !== 0) throw new Error(`Expected zero unpublished outbox events, received ${pipelineBody.outbox?.unpublished}`);
process.stdout.write(`${JSON.stringify({ status: 'PASS', build: liveBody.build, apiUrl, appUrl, pipeline: pipelineBody.status })}\n`);
