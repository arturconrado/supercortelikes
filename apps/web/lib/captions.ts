export function captionTrackDataUrl(cues: unknown): string | undefined {
  const vtt = cuesToWebVtt(cues);
  return vtt ? `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}` : undefined;
}

export function cuesToWebVtt(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const cue = item as Record<string, unknown>;
    const start = finiteNumber(cue.start);
    const end = finiteNumber(cue.end);
    const text = cueText(cue);
    if (start === undefined || end === undefined || end <= start || !text) continue;
    blocks.push(`${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${text}`);
  }
  return blocks.length ? `WEBVTT\n\n${blocks.join('\n\n')}\n` : undefined;
}

function cueText(cue: Record<string, unknown>): string {
  if (typeof cue.text === 'string') return cleanText(cue.text);
  if (!Array.isArray(cue.words)) return '';
  return cleanText(cue.words.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const word = item as Record<string, unknown>;
    return typeof word.word === 'string' ? word.word : typeof word.text === 'string' ? word.text : '';
  }).join(' '));
}

function cleanText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function vttTimestamp(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return [hours, minutes, remainingSeconds].map((item) => String(item).padStart(2, '0')).join(':') + `.${String(milliseconds).padStart(3, '0')}`;
}
