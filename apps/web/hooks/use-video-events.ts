'use client';

import { useEffect, useState } from 'react';
import { API_URL, TOKEN_KEY } from '@/lib/api';

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
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setState({ connected: false, error: 'Sessão ausente para eventos em tempo real.', lastEventAt: null });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function connect() {
      try {
        const response = await fetch(`${API_URL}/videos/${videoId}/events`, {
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
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
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          connected: false,
          error: error instanceof Error ? error.message : 'Tempo real indisponível.',
        }));
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
