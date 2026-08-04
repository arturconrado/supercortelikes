'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { analyticsConsent, setAnalyticsConsent } from '@/lib/api';
import { Button } from '@/components/ui';

export function AnalyticsConsentBanner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const sync = () => setVisible(analyticsConsent() === 'unknown');
    sync();
    window.addEventListener('picashorts:analytics-consent', sync);
    return () => window.removeEventListener('picashorts:analytics-consent', sync);
  }, []);
  if (!visible) return null;
  return <aside aria-label="Preferências de analytics" className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#111319] p-4 shadow-2xl sm:flex sm:items-center sm:gap-5">
    <p className="min-w-0 flex-1 text-sm leading-6 text-zinc-300">Podemos registrar eventos de uso sem conteúdo, tokens ou dados pessoais para melhorar a qualidade do PicaShorts. <Link className="text-lime underline" href="/privacy">Saiba mais</Link>.</p>
    <div className="mt-3 flex shrink-0 flex-wrap gap-2 sm:mt-0">
      <Button size="sm" variant="ghost" onClick={() => setAnalyticsConsent('denied')}>Somente necessários</Button>
      <Button size="sm" onClick={() => setAnalyticsConsent('granted')}>Permitir analytics</Button>
    </div>
  </aside>;
}
