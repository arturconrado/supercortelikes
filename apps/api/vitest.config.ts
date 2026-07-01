import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/auth/**/*.ts',
        'src/projects/**/*.ts',
        'src/videos/**/*.ts',
        'src/queues/**/*.ts',
        'src/health/**/*.ts',
        'src/media/**/*.ts',
        'src/storage/**/*.ts',
        'src/exports/**/*.ts',
        'src/content/**/*.ts',
      ],
      exclude: [
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/**/*.types.ts',
        'src/**/*-health.ts',
        'src/videos/video.repository.ts',
        'src/storage/storage.port.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 60,
      },
    },
  },
});
