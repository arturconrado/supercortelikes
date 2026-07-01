const token = process.env.RENDER_API_KEY;
const serviceIds = (process.env.RENDER_SERVICE_IDS ?? '').split(',').filter(Boolean);
const expectedSha = process.env.EXPECTED_SHA;
if (!token || serviceIds.length !== 2 || !expectedSha) throw new Error('Render token, two service IDs and EXPECTED_SHA are required');
const deadline = Date.now() + 30 * 60 * 1000;
const complete = new Set();
while (Date.now() < deadline && complete.size < serviceIds.length) {
  for (const serviceId of serviceIds) {
    if (complete.has(serviceId)) continue;
    const response = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=5`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Render API returned ${response.status} for ${serviceId}`);
    const records = await response.json();
    const deploy = records.map((record) => record.deploy ?? record).find((item) => item.commit?.id === expectedSha);
    if (!deploy) continue;
    if (['build_failed', 'update_failed', 'canceled', 'deactivated'].includes(deploy.status)) {
      throw new Error(`Render deployment ${serviceId} failed with ${deploy.status}`);
    }
    if (deploy.status === 'live') complete.add(serviceId);
  }
  if (complete.size < serviceIds.length) await new Promise((resolve) => setTimeout(resolve, 15_000));
}
if (complete.size !== serviceIds.length) throw new Error('Render deployment wait timed out');
process.stdout.write(`${JSON.stringify({ status: 'live', sha: expectedSha, services: [...complete] })}\n`);
