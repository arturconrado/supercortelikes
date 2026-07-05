import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UploadPage from './page';

const apiMock = vi.fn();
const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  endpoints: { imports: '/videos/import', usage: '/usage/current' },
}));

vi.mock('@/hooks/use-resource', () => ({
  useResource: () => ({
    data: {
      plan: 'FREE',
      usage: { minutes: 0, limit: 30, remaining: 30 },
      limits: { maxUploadBytes: 5 * 1024 ** 3, exportResolution: '720p', watermark: false },
    },
  }),
}));

vi.mock('@/lib/upload', () => ({
  uploadVideo: vi.fn(),
  validateVideo: vi.fn(() => null),
}));

describe('UploadPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', { randomUUID: () => 'yt-import-key-1234' });
    apiMock.mockResolvedValue({ id: 'video-1', status: 'UPLOADED' });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts a URL import with an idempotency key', async () => {
    render(<UploadPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar importação por URL' }));
    fireEvent.change(screen.getByLabelText('URL do vídeo'), {
      target: { value: ' https://www.youtube.com/watch?v=VYDE529RzNk ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Importar$/ }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/videos/import', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'yt-import-key-1234' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=VYDE529RzNk',
        processingOptions: {
          durationPreset: 'AUTO',
          minimumDurationSeconds: 15,
          maximumDurationSeconds: 90,
          clipCount: 20,
          aspectRatio: '9:16',
          targetPlatform: 'AUTO',
        },
      }),
    }));
    expect(screen.getByText('Importação iniciada. Abrindo a tela do vídeo…')).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith('/library/video-1');
  });
});
