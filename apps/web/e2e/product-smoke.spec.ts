import { expect, test } from '@playwright/test';
import { assertRegisterContract, createMockState, loginInBrowser, mockClipbrApi } from './fixtures';

test('cadastro mostra qualidade de senha e envia o contrato correto', async ({ page }) => {
  const state = await mockClipbrApi(page, createMockState({ meDelayMs: 250 }));
  await page.goto('/register');
  await page.getByLabel('Nome').fill('Ana Demo');
  await page.getByLabel('E-mail').fill('ana@clipbr.test');
  await page.getByLabel('Senha').fill('Password12345');
  await expect(page.getByText('Senha boa')).toBeVisible();
  await page.getByLabel(/Li e aceito/i).check();
  await page.getByRole('button', { name: /Criar conta/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(state.registerRequests).toHaveLength(1);
  assertRegisterContract(state.registerRequests[0]!);
});

test('importa URL, redireciona para vídeo, mostra cortes, preview e editor', async ({ page }) => {
  const state = await mockClipbrApi(page, createMockState());
  await loginInBrowser(page);
  await page.goto('/upload');
  await page.getByLabel('Selecionar importação por URL').click();
  await page.getByLabel('URL do vídeo').fill('https://www.youtube.com/watch?v=VYDE529RzNk');
  await page.getByRole('button', { name: /^Importar$/ }).click();

  await expect(page).toHaveURL(/\/library\/video-1$/);
  await expect(page.getByRole('heading', { name: 'Processamento' })).toBeVisible();
  await expect(page.getByText('Cortes encontrados')).toBeVisible();
  await expect(page.getByText('Gancho forte para Reels')).toBeVisible();
  expect(state.importRequests[0]).toMatchObject({
    url: 'https://www.youtube.com/watch?v=VYDE529RzNk',
    processingOptions: expect.objectContaining({ aspectRatio: '9:16', clipCount: 20 }),
  });

  await page.getByRole('button', { name: /Preview/i }).click();
  await expect(page.getByRole('dialog', { name: /Gancho forte para Reels/i })).toBeVisible();
  await page.getByRole('link', { name: /Abrir editor/i }).click();

  await expect(page).toHaveURL(/\/clips\/clip-1$/);
  await expect(page.getByText('Timing e formato')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Legendas' })).toBeVisible();
  await expect(page.getByText('Conteúdo e SEO')).toBeVisible();
});
