import { expect, test } from '@playwright/test';
import { createMockState, defaultVideo, loginInBrowser, mockClipbrApi, pipelineFailed } from './fixtures';

test('vídeo com falha mostra erro de pipeline e permite retry', async ({ page }) => {
  const state = await mockClipbrApi(page, createMockState({
    video: { ...structuredClone(defaultVideo), processingStatus: 'FAILED', currentStage: 'TRANSCRIPTION', clipsCount: 0 },
    clips: [],
    pipeline: structuredClone(pipelineFailed),
  }));
  await loginInBrowser(page);

  await page.goto('/library/video-1');
  await expect(page.getByText('O processamento encontrou um erro.')).toBeVisible();
  await expect(page.getByText('Transcrição falhou.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Tentar novamente/i }).click();
  await expect.poll(() => state.retryCount).toBe(1);
  await expect(page.getByText('O processamento encontrou um erro.')).toBeHidden();
});

test('biblioteca renderiza thumbnail real e permite abrir o vídeo importado', async ({ page }) => {
  await mockClipbrApi(page, createMockState());
  await loginInBrowser(page);

  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'Biblioteca' })).toBeVisible();
  await expect(page.getByText('Entrevista Demo')).toBeVisible();
  await expect(page.locator('img[src="https://storage.test/thumb.jpg"]').first()).toBeVisible();
  await page.getByText('Entrevista Demo').click();
  await expect(page).toHaveURL(/\/library\/video-1$/);
});
