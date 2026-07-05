import { describe, expect, it } from 'vitest';
import { DEFAULT_PIPELINE_STAGE_CONCURRENCY, parsePipelineStageConcurrency } from './media-workers.service';

describe('parsePipelineStageConcurrency', () => {
  it('merges partial configuration with aggressive VPS defaults', () => {
    expect(parsePipelineStageConcurrency('{"transcription":1,"rendering":1}')).toEqual({
      ...DEFAULT_PIPELINE_STAGE_CONCURRENCY,
      transcription: 1,
      rendering: 1,
    });
  });

  it('rejects malformed or unsafe concurrency values', () => {
    expect(() => parsePipelineStageConcurrency('not-json')).toThrow(/Invalid PIPELINE_STAGE_CONCURRENCY_JSON/);
    expect(() => parsePipelineStageConcurrency('[]')).toThrow(/must be a JSON object/);
    expect(() => parsePipelineStageConcurrency('{"ingestion":0}')).toThrow(/ingestion/);
    expect(() => parsePipelineStageConcurrency('{"rendering":99}')).toThrow(/rendering/);
  });
});
