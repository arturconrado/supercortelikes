'use client';

import { useEffect, useState } from 'react';
import { authenticatedFetch, hasSession } from '@/lib/api';

export type PipelineEventSnapshot<TPipeline = unknown> = {
  generatedAt: string;
  clipsCount: number;
  readyExportsCount: number;
  pipeline: TPipeline;
};

type UseVideoEventsState = {
  connected: boolean;
  error: string | null;
  lastEventAt: Date | null;
};

type ServerSentEvent = {
  event: string;
  data: string;
};

export function useVideoEvents<TPipeline = unknown>(
  videoId: string | undefined,
  enabled: boolean,
  onSnapshot: (snapshot: PipelineEventSnapshot<TPipeline>) => void,
): UseVideoEventsState {
  const [state, setState] = useState<UseVideoEventsState>({ connected: false, error: null, lastEventAt: null });

  useEffect(() => {
    if (!enabled || !videoId) {
      setState((current) => ({ ...current, connected: false }));
      return;
    }
    if (!hasSession()) {
      setState({ connected: false, error: 'Sessão ausente para eventos em tempo real.', lastEventAt: null });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function connect() {
      let reconnectAttempt = 0;
      while (!cancelled && !controller.signal.aborted && hasSession()) {
        try {
          const response = await authenticatedFetch(`/videos/${videoId}/events`, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
          reconnectAttempt = 0;
          setState((current) => ({ ...current, connected: true, error: null }));
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const boundary = buffer.split('\n\n');
            buffer = boundary.pop() ?? '';
            for (const chunk of boundary) {
              const message = parseServerSentEvent(chunk);
              if (!message) continue;
              setState((current) => ({ ...current, lastEventAt: new Date() }));
              if (message.event === 'pipeline.snapshot') {
                onSnapshot(JSON.parse(message.data) as PipelineEventSnapshot<TPipeline>);
              }
            }
          }
          setState((current) => ({ ...current, connected: false }));
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          setState((current) => ({
            ...current,
            connected: false,
            error: error instanceof Error ? error.message : 'Tempo real indisponível.',
          }));
        }
        reconnectAttempt += 1;
        await reconnectDelay(Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 4)), controller.signal);
      }
    }

    void connect();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, onSnapshot, videoId]);

  return state;
}

function reconnectDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

function parseServerSentEvent(chunk: string): ServerSentEvent | null {
  const lines = chunk.split('\n');
  let event = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}
