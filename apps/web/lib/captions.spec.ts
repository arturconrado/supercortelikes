import { describe, expect, it } from 'vitest';
import { captionTrackDataUrl, cuesToWebVtt } from './captions';

describe('native caption track', () => {
  it('converts generated word cues to browser-compatible WebVTT', () => {
    expect(cuesToWebVtt([{ start: 0.25, end: 2.5, words: [{ word: 'Olá' }, { word: 'mundo' }] }])).toBe(
      'WEBVTT\n\n00:00:00.250 --> 00:00:02.500\nOlá mundo\n',
    );
  });

  it('supports edited text cues and ignores invalid timing', () => {
    const url = captionTrackDataUrl([
      { start: 0, end: 1, text: 'Texto editado' },
      { start: 2, end: 1, text: 'inválido' },
    ]);
    expect(url).toMatch(/^data:text\/vtt/);
    expect(decodeURIComponent(url!.split(',', 2)[1]!)).toContain('Texto editado');
    expect(decodeURIComponent(url!.split(',', 2)[1]!)).not.toContain('inválido');
  });
});
