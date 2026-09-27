import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.PICASHORTS_BASE_URL || 'https://picashorts.com';
const FIXTURE = process.argv[2];
const SCENARIO_ID = process.argv[3] || 'unknown';
const EXPECTED_ASPECT_RATIO = process.env.EXPECTED_ASPECT_RATIO || '9:16';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '.';
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 6);
const EXPORT_POLL_MINUTES = Number(process.env.EXPORT_POLL_MINUTES || 6);
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';

const ASPECT_RATIO_TARGETS = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };

if (!FIXTURE) {
  console.error('Usage: node browser-production-diagnostic.mjs <path-to-fixture> [scenarioId]');
  process.exit(1);
}

const fixturePath = path.resolve(FIXTURE);
if (!fs.existsSync(fixturePath)) {
  console.error(`Fixture not found: ${fixturePath}`);
  process.exit(1);
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const [emailUser, emailDomain] = (process.env.PICASHORTS_DIAG_EMAIL || 'arturconrado@gmail.com').split('@');
const email = `${emailUser}+picashorts-browser-${runId}@${emailDomain}`;
// Never commit a shared password for accounts created in production.
const password = process.env.PICASHORTS_DIAG_PASSWORD || `Diag-${randomBytes(12).toString('base64url')}1!`;
const displayName = 'PicaShorts Browser Diagnostic';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true }).catch(() => {});
}

function pushIfChanged(list, snapshot) {
  const last = list[list.length - 1];
  if (!last || JSON.stringify(last) !== JSON.stringify({ ...snapshot, at: last.at })) {
    list.push(snapshot);
    return true;
  }
  return false;
}

async function inspectExportedMp4(localPath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      localPath,
    ]);
    const probe = JSON.parse(stdout);
    const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
    const durationSeconds = Number(probe.format?.duration ?? videoStream?.duration ?? 0);
    const width = Number(videoStream?.width ?? 0);
    const height = Number(videoStream?.height ?? 0);
    const measuredRatio = height ? width / height : 0;
    const target = ASPECT_RATIO_TARGETS[EXPECTED_ASPECT_RATIO];
    const aspectRatioOk = target ? Math.abs(measuredRatio - target) / target < 0.03 : null;
    return {
      status: 'PROBED',
      width,
      height,
      measuredRatio: Number(measuredRatio.toFixed(4)),
      durationSeconds,
      codecName: videoStream?.codec_name,
      rotateTag: videoStream?.tags?.rotate ?? videoStream?.side_data_list?.find((item) => item.rotation !== undefined)?.rotation,
      checks: {
        hasVideoStream: Boolean(videoStream),
        aspectRatioOk,
        shortSideWithinLimit: width && height ? Math.min(width, height) <= 1080 : null,
        durationNonZero: durationSeconds > 0,
      },
    };
  } catch (error) {
    return { status: 'FFPROBE_ERROR', message: String(error) };
  }
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const videoSnapshots = [];
  const clipsSnapshots = [];
  const clipDetailById = new Map();

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const pathname = new URL(url).pathname;
      if (response.request().method() !== 'GET' || response.status() !== 200) return;

      if (/\/videos\/[a-zA-Z0-9-]+$/.test(pathname)) {
        const body = await response.json();
        const snapshot = {
          at: new Date().toISOString(),
          id: body.id,
          status: body.status,
          processingStatus: body.processingStatus,
          currentStage: body.currentStage,
          audioPresent: body.audioPresent,
          speechDetected: body.speechDetected,
          processingMode: body.processingMode,
          speakerCount: body.speakerCount,
          durationSeconds: body.durationSeconds,
        };
        if (pushIfChanged(videoSnapshots, snapshot)) log('VIDEO SNAPSHOT', JSON.stringify(snapshot));
        return;
      }

      if (/\/videos\/[a-zA-Z0-9-]+\/clips$/.test(pathname)) {
        const body = await response.json();
        const snapshot = {
          at: new Date().toISOString(),
          clips: (Array.isArray(body) ? body : []).map((clip) => ({
            id: clip.id,
            status: clip.status,
            aspectRatio: clip.aspectRatio,
            durationSeconds: clip.durationSeconds,
            composition: clip.composition ?? null,
            downloadUrl: clip.downloadUrl,
          })),
        };
        if (pushIfChanged(clipsSnapshots, snapshot)) {
          log('CLIPS SNAPSHOT', JSON.stringify(snapshot.clips.map((clip) => ({ id: clip.id, status: clip.status, diagnostics: clip.composition?.diagnostics }))));
        }
        return;
      }

      if (/\/clips\/[a-zA-Z0-9-]+$/.test(pathname)) {
        const body = await response.json();
        if (body?.id) {
          clipDetailById.set(body.id, body);
          if (body.downloadUrl) log('CLIP DOWNLOAD READY', body.id, body.downloadUrl);
        }
      }
    } catch {
      // ignore non-JSON or unrelated responses
    }
  });

  try {
    log('SCENARIO', SCENARIO_ID, 'BASE_URL', BASE_URL, 'FIXTURE', fixturePath, 'EXPECTED_ASPECT_RATIO', EXPECTED_ASPECT_RATIO);
    await page.goto(`${BASE_URL}/register`);
    await shot(page, '01-register');

    const turnstileCount = await page
      .locator('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]')
      .count();
    if (turnstileCount > 0) {
      await shot(page, '02-turnstile-blocked');
      console.log(JSON.stringify({ status: 'BLOCKED_BY_TURNSTILE' }));
      await browser.close();
      process.exit(2);
    }

    await page.getByLabel('Nome').fill(displayName);
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Criar conta/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    log('SIGNUP_OK', email);
    await shot(page, '03-dashboard');

    const consentBanner = page.getByRole('button', { name: /Somente necessários/i });
    if (await consentBanner.isVisible().catch(() => false)) {
      await consentBanner.click();
      log('DISMISSED_CONSENT_BANNER');
    }

    await page.goto(`${BASE_URL}/upload`);
    const uploadConsentBanner = page.getByRole('button', { name: /Somente necessários/i });
    if (await uploadConsentBanner.isVisible().catch(() => false)) {
      await uploadConsentBanner.click();
      log('DISMISSED_CONSENT_BANNER_ON_UPLOAD');
    }

    if (EXPECTED_ASPECT_RATIO !== '9:16') {
      const ratioDescriptions = { '1:1': 'Feed quadrado', '4:5': 'Instagram vertical', '16:9': 'YouTube horizontal' };
      const description = ratioDescriptions[EXPECTED_ASPECT_RATIO];
      if (description) {
        await page.locator(`button:has-text("${description}")`).click().catch(() => {});
        log('ASPECT_RATIO_SELECTED', EXPECTED_ASPECT_RATIO);
      }
    }

    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await shot(page, '04-file-selected');
    await page.getByRole('button', { name: /Iniciar upload/i }).click();
    await page.waitForURL(/\/library\//, { timeout: 120_000 });
    const videoId = page.url().split('/library/')[1];
    log('UPLOAD_OK', 'videoId=', videoId);
    await shot(page, '05-library-detail');

    const pipelineDeadline = Date.now() + POLL_MINUTES * 60_000;
    let lastText = '';
    while (Date.now() < pipelineDeadline) {
      await page.reload();
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (bodyText !== lastText) lastText = bodyText;
      const terminal = /FAILED|Falhou|SUCCEEDED|Conclu[íi]do/i.test(bodyText);
      if (terminal) break;
      await page.waitForTimeout(5000);
    }
    await shot(page, '06-final-state');

    // Give the clips grid one more chance to fetch after the pipeline reaches a terminal state.
    await page.reload();
    await page.waitForTimeout(3000);

    const latestClips = clipsSnapshots[clipsSnapshots.length - 1]?.clips ?? [];
    const selectedClip = latestClips.find((clip) => clip.id) ?? null;
    let editorScreenshot = null;
    let exportCheck = null;

    if (selectedClip) {
      await page.goto(`${BASE_URL}/clips/${selectedClip.id}`);
      const exportButton = page.getByRole('button', { name: /Gerar e baixar|Gerar novamente/i }).first();
      await exportButton.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
      await shot(page, '07-clip-editor');
      editorScreenshot = path.join(SCREENSHOT_DIR, '07-clip-editor.png');

      if (await exportButton.isVisible().catch(() => false)) {
        await exportButton.click();
        log('EXPORT_REQUESTED', selectedClip.id);

        const exportDeadline = Date.now() + EXPORT_POLL_MINUTES * 60_000;
        let downloadUrl = clipDetailById.get(selectedClip.id)?.downloadUrl;
        while (!downloadUrl && Date.now() < exportDeadline) {
          await page.waitForTimeout(5000);
          downloadUrl = clipDetailById.get(selectedClip.id)?.downloadUrl;
        }

        if (downloadUrl) {
          const localPath = path.join(SCREENSHOT_DIR, `export-${selectedClip.id}.mp4`);
          const response = await fetch(downloadUrl);
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(localPath, buffer);
          log('EXPORT_DOWNLOADED', localPath, buffer.length, 'bytes');
          const ffprobeResult = await inspectExportedMp4(localPath);
          exportCheck = { downloadUrl, localPath, ffprobe: ffprobeResult };
        } else {
          exportCheck = { status: 'EXPORT_TIMED_OUT' };
        }
      } else {
        exportCheck = { status: 'EXPORT_BUTTON_NOT_FOUND' };
      }
    }

    console.log(
      JSON.stringify({
        status: 'DONE',
        scenarioId: SCENARIO_ID,
        videoId,
        finalUrl: page.url(),
        snapshots: videoSnapshots,
        clips: latestClips,
        selectedClipId: selectedClip?.id ?? null,
        editorScreenshot,
        exportCheck,
      }, null, 2),
    );
  } catch (error) {
    await shot(page, '99-error-state');
    console.log(JSON.stringify({ status: 'SCRIPT_ERROR', message: String(error) }));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
