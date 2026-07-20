import { describe, expect, it } from 'vitest';
import { MediaStageProcessor } from './media-stage.processor';

type WatermarkSubject = {
  watermarkOptions: (
    pipelineRunId: string,
    video?: { workspace?: { brandKits: Array<{ logoKey: string | null; watermark: unknown }> } | null },
  ) => Promise<Record<string, unknown>>;
};

function watermarkSubject(): WatermarkSubject {
  return Object.create(MediaStageProcessor.prototype) as WatermarkSubject;
}

describe('MediaStageProcessor watermark options', () => {
  it('does not add a platform watermark when the workspace has no explicit brand mark', async () => {
    const subject = watermarkSubject();

    await expect(subject.watermarkOptions('pipeline', { workspace: { brandKits: [] } })).resolves.toEqual({});
    await expect(
      subject.watermarkOptions('pipeline', {
        workspace: { brandKits: [{ logoKey: null, watermark: { position: 'W-w-32:H-h-32' } }] },
      }),
    ).resolves.toEqual({});
  });

  it('keeps an explicitly configured customer text watermark', async () => {
    const subject = watermarkSubject();

    await expect(
      subject.watermarkOptions('pipeline', {
        workspace: {
          brandKits: [{ logoKey: null, watermark: { text: 'Minha marca', position: '32:32', opacity: 0.5 } }],
        },
      }),
    ).resolves.toEqual({
      watermarkText: 'Minha marca',
      watermarkTextPosition: '32:32',
      watermarkTextOpacity: 0.5,
    });
  });
});
