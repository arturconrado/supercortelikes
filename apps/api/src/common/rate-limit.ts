export function routeLimit(url: string, method: string, fallback: number): number {
  const path = pathname(url);
  if (path.startsWith('/auth/login') || path.startsWith('/auth/register')) return 20;
  if (path.startsWith('/auth/refresh')) return 120;
  if (path.startsWith('/auth/password/forgot') || path.startsWith('/auth/email/verification')) return 10;
  if (path.startsWith('/billing/checkout')) return 30;
  if (path.startsWith('/api/mercado-pago/webhook')) return 600;
  if (path.startsWith('/videos/presigned-upload')) return 60;
  if (path.includes('/upload-parts')) return 180;
  if (method === 'DELETE' && path.startsWith('/videos/')) return 60;
  return fallback;
}

export function rateLimitKey(url: string, ip: string): string {
  const path = pathname(url);
  if (path.startsWith('/auth/login')) return `${ip}:auth-login`;
  if (path.startsWith('/auth/register')) return `${ip}:auth-register`;
  if (path.startsWith('/auth/refresh')) return `${ip}:auth-refresh`;
  if (path.startsWith('/auth/password/forgot') || path.startsWith('/auth/email/verification')) return `${ip}:auth-recovery`;
  if (path.startsWith('/billing/checkout')) return `${ip}:billing-checkout`;
  if (path.startsWith('/api/mercado-pago/webhook')) return `${ip}:billing-webhook`;
  if (path.startsWith('/videos/presigned-upload') || path.includes('/upload-parts')) return `${ip}:upload`;
  return `${ip}:general`;
}

function pathname(url: string): string {
  return url.split('?', 1)[0] ?? url;
}
