'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef, useState } from 'react';

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
  remove?: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

type TurnstileBoxProps = {
  action: string;
  siteKey?: string;
  onToken: (token: string) => void;
};

export function TurnstileBox({ action, siteKey, onToken }: TurnstileBoxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const renderWidget = useCallback(() => {
    if (!siteKey || !loaded || !containerRef.current || !window.turnstile || widgetIdRef.current) return;
    const widgetId = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      action,
      theme: 'dark',
      callback: (token: string) => onToken(token),
      'expired-callback': () => onToken(''),
      'error-callback': () => onToken(''),
    });
    if (widgetId) widgetIdRef.current = widgetId;
  }, [action, loaded, onToken, siteKey]);

  useEffect(() => {
    renderWidget();
  }, [renderWidget]);

  useEffect(() => () => {
    if (widgetIdRef.current) window.turnstile?.remove?.(widgetIdRef.current);
  }, []);

  if (!siteKey) return null;

  return (
    <div className="space-y-2">
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onLoad={() => setLoaded(true)}
      />
      <div ref={containerRef} className="min-h-[65px]" />
      <p className="text-[11px] leading-4 text-zinc-600">Proteção antiabuso Cloudflare Turnstile.</p>
    </div>
  );
}
