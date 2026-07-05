import { expect, test } from '@playwright/test';
import { createMockState, loginInBrowser, mockClipbrApi } from './fixtures';

test('editor salva timing, formato, legendas, SEO e solicita export', async ({ page }) => {
  const state = await mockClipbrApi(page, createMockState());
  await loginInBrowser(page);

  await page.goto('/clips/clip-1');
  await expect(page.getByRole('heading', { name: 'Gancho forte para Reels' })).toBeVisible();

  await page.getByLabel('Início (s)').fill('10');
  await page.getByLabel('Fim (s)').fill('35');
  await page.getByLabel('Formato').selectOption('4:5');
  await page.getByRole('button', { name: /Salvar timing/i }).click();
  await expect(page.getByText('Timing e formato salvos. Renderize novamente para aplicar.')).toBeVisible();
  expect(state.timingPatchRequests[0]).toEqual({ startSeconds: 10, endSeconds: 35 });
  expect(state.clipPatchRequests[0]).toMatchObject({ aspectRatio: '4:5' });

  await page.getByLabel('Estilo').selectOption('marketing');
  await page.getByLabel('Cor principal').fill('#ff0000');
  await page.getByLabel('Cor destaque').fill('#00ff00');
  await page.getByRole('button', { name: /Salvar legendas/i }).click();
  await expect(page.getByText('Estilo de legenda salvo. Renderize novamente para aplicar.')).toBeVisible();
  expect(state.captionPatchRequests[0]).toMatchObject({
    template: 'marketing',
    style: { primaryColor: '#ff0000', highlightColor: '#00ff00' },
  });

  await page.getByLabel('Título').fill('Novo título viral');
  await page.getByLabel('Descrição').fill('Descrição revisada para publicação.');
  await page.getByLabel('Hashtags').fill('#novo #viral');
  await page.getByRole('button', { name: /^Salvar$/ }).click();
  await expect(page.getByText('Conteúdo e SEO salvos.')).toBeVisible();
  expect(state.clipPatchRequests.at(-1)).toMatchObject({
    title: 'Novo título viral',
    description: 'Descrição revisada para publicação.',
    hashtags: ['#novo', '#viral'],
  });

  await page.getByRole('button', { name: /Gerar novamente|Gerar e baixar/i }).first().click();
  await expect(page.getByText('Exportação pronta. Você já pode baixar o MP4.')).toBeVisible();
  expect(state.exportRequests[0]).toMatchObject({ format: 'MP4', aspectRatio: '4:5' });
});

test('editor valida timing inválido antes de chamar API', async ({ page }) => {
  const state = await mockClipbrApi(page, createMockState());
  await loginInBrowser(page);

  await page.goto('/clips/clip-1');
  await page.getByLabel('Início (s)').fill('50');
  await page.getByLabel('Fim (s)').fill('20');
  await page.getByRole('button', { name: /Salvar timing/i }).click();

  await expect(page.getByText('Informe um início e fim válidos para o corte.')).toBeVisible();
  expect(state.timingPatchRequests).toHaveLength(0);
});
