import { expect, test } from '@playwright/test';
import { createMockState, loginInBrowser, mockClipbrApi } from './fixtures';

test('upload direto multipart pelo browser confirma objeto e abre tela do vídeo', async ({ page }) => {
  const state = await mockClipbrApi(page, createMockState());
  await loginInBrowser(page);
  await page.goto('/upload');

  await page.getByRole('button', { name: /^1:1/ }).click();
  await page.getByLabel('Quantidade de cortes').selectOption('10');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'demo-upload.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fake mp4 content for browser e2e'),
  });

  await expect(page.getByText('demo-upload.mp4')).toBeVisible();
  await page.getByRole('button', { name: /Iniciar upload/i }).click();
  await expect(page).toHaveURL(/\/library\/video-1$/);

  expect(state.presignedUploadRequests).toHaveLength(1);
  expect(state.presignedUploadRequests[0]).toMatchObject({
    filename: 'demo-upload.mp4',
    mimeType: 'video/mp4',
    processingOptions: expect.objectContaining({ aspectRatio: '1:1', clipCount: 10 }),
  });
  expect(state.uploadPartRequests.length).toBeGreaterThanOrEqual(2);
  expect(state.confirmUploadRequests[0]).toMatchObject({
    videoId: 'video-1',
    uploadId: 'upload-1',
    parts: [{ partNumber: 1, etag: '"etag-2"' }],
  });
});

test('importação por URL mostra erro útil e permanece na tela de upload', async ({ page }) => {
  await mockClipbrApi(page, createMockState({ importError: { status: 400, message: 'Link não suportado para importação.' } }));
  await loginInBrowser(page);
  await page.goto('/upload');
  await page.getByLabel('Selecionar importação por URL').click();
  await page.getByLabel('URL do vídeo').fill('https://example.com/pagina-sem-video');
  await page.getByRole('button', { name: /^Importar$/ }).click();

  await expect(page).toHaveURL(/\/upload$/);
  await expect(page.getByText('Link não suportado para importação.')).toBeVisible();
});
