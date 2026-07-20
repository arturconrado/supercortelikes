import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { VideosModule } from '../videos/videos.module';
import { MediaClientModule } from './media-client.module';
import { MediaModule } from './media.module';
import { MediaWorkerClient } from './media-worker.client';
import { MediaWorkersService } from './media-workers.service';

describe('media module boundaries', () => {
  it('keeps queue consumers out of the HTTP application graph', () => {
    const videoImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, VideosModule) as unknown[];
    const clientProviders = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MediaClientModule) as unknown[];

    expect(videoImports).toContain(MediaClientModule);
    expect(videoImports).not.toContain(MediaModule);
    expect(clientProviders).toContain(MediaWorkerClient);
    expect(clientProviders).not.toContain(MediaWorkersService);
  });
});
