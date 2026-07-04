'use client';

export function startFileDownload(url: string, filename?: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_self';
  anchor.rel = 'noopener';
  if (filename) anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
