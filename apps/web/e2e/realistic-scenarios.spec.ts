import { expect, test } from '@playwright/test';
import { createMockState, defaultVideo, mockClipbrApi } from './fixtures';

const scenarios = [
  { id: 'podcast-1h-single-speaker', durationSeconds: 3600, processingMode: 'speech', audioPresent: true, speechDetected: true, speakerCount: 1 },
  { id: 'podcast-45m-two-speakers', durationSeconds: 2700, processingMode: 'speech', audioPresent: true, speechDetected: true, speakerCount: 2 },
  { id: 'podcast-30m-overlap', durationSeconds: 1800, processingMode: 'speech', audioPresent: true, speechDetected: true, speakerCount: 3 },
  { id: 'music-video-12m', durationSeconds: 720, processingMode: 'visual', audioPresent: true, speechDetected: false, speakerCount: 0 },
  { id: 'silent-vertical-8m', durationSeconds: 480, processingMode: 'visual', audioPresent: false, speechDetected: false, speakerCount: 0 },
  { id: 'low-resolution-portrait-90s', durationSeconds: 90, processingMode: 'speech', audioPresent: true, speechDetected: true, speakerCount: 1 },
  { id: 'near-plan-limit-59m', durationSeconds: 3540, processingMode: 'speech', audioPresent: true, speechDetected: true, speakerCount: 1 },
] as const;

test.describe('cenários multimodais realistas no navegador', () => {
  for (const scenario of scenarios) {
    test(`${scenario.id} — detalhes e estado de processamento`, async ({ page }) => {
      const state = await mockClipbrApi(page, createMockState({
        video: {
          ...structuredClone(defaultVideo),
          title: scenario.id,
          durationSeconds: scenario.durationSeconds,
          processingMode: scenario.processingMode,
          audioPresent: scenario.audioPresent,
          speechDetected: scenario.speechDetected,
          speakerCount: scenario.speakerCount,
        },
      }));
      await page.goto('/login');
      await page.getByLabel('E-mail').fill('ana@clipbr.test');
      await page.getByRole('textbox', { name: 'Senha' }).fill('Password12345');
      await page.getByRole('button', { name: 'Entrar' }).click();
      await page.goto('/library/video-1');

      await expect(page.getByText(scenario.processingMode === 'visual' ? 'Análise visual' : 'Análise de fala').first()).toBeVisible();
      await expect(page.getByText(scenario.audioPresent ? (scenario.speechDetected ? 'Detectado' : 'Sem fala detectada') : 'Sem faixa de áudio')).toBeVisible();
      await expect(page.getByText(String(scenario.speakerCount), { exact: true })).toBeVisible();
      expect(state.video.durationSeconds).toBe(scenario.durationSeconds);
      expect(state.video.processingMode).toBe(scenario.processingMode);
    });
  }
});

test('vídeo visual explica que não haverá legendas automáticas', async ({ page }) => {
  await mockClipbrApi(page, createMockState({
    video: { ...structuredClone(defaultVideo), processingMode: 'visual', audioPresent: false, speechDetected: false, speakerCount: 0 },
  }));
  await page.goto('/login');
  await page.getByLabel('E-mail').fill('ana@clipbr.test');
  await page.getByRole('textbox', { name: 'Senha' }).fill('Password12345');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.goto('/library/video-1');
  await expect(page.getByText(/legendas automáticas ficam desativadas/i)).toBeVisible();
});
