'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, unwrap, unwrapList } from '@/lib/api';

export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError(undefined);
    try { setData(unwrap(await api<T | { data: T }>(path))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Falha ao carregar os dados.'); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, loading, error, refresh, setData };
}

export function useCollection<T>(path: string | null) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError(undefined);
    try { setData(unwrapList(await api<T[] | { data?: T[]; items?: T[]; results?: T[] }>(path))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Falha ao carregar os dados.'); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, loading, error, refresh, setData };
}
