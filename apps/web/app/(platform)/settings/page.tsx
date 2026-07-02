'use client';

import { Bell, Check, ImageIcon, KeyRound, LoaderCircle, Palette, UserRound } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Alert, Button, Card, Input, Label, PageHeader } from '@/components/ui';
import { api, endpoints } from '@/lib/api';

type Tab = 'profile' | 'brand' | 'security' | 'notifications';

type BrandKitState = {
  name: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  watermarkText: string;
  logoKey: string;
  watermarkPosition: string;
  watermarkOpacity: number;
};

const tabs = [
  { id: 'profile' as Tab, label: 'Perfil', icon: UserRound },
  { id: 'brand' as Tab, label: 'Brand kit', icon: Palette },
  { id: 'security' as Tab, label: 'Segurança', icon: KeyRound },
  { id: 'notifications' as Tab, label: 'Notificações', icon: Bell },
];

const positionOptions = [
  { value: '32:32', label: 'Topo esquerdo', className: 'items-start justify-start' },
  { value: 'W-w-32:32', label: 'Topo direito', className: 'items-start justify-end' },
  { value: '32:H-h-32', label: 'Base esquerda', className: 'items-end justify-start' },
  { value: 'W-w-32:H-h-32', label: 'Base direita', className: 'items-end justify-end' },
  { value: 'W-tw-32:H-th-32', label: 'Base direita (texto)', className: 'items-end justify-end' },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('profile');
  const { user, refresh } = useAuth();

  return (
    <>
      <PageHeader
        eyebrow="Preferências"
        title="Configurações"
        description="Personalize sua conta, sua marca e as notificações."
      />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="h-fit rounded-2xl border border-white/[.07] bg-panel p-2">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition ${tab === id ? 'bg-lime/[.09] text-lime' : 'text-zinc-500 hover:bg-white/[.04] hover:text-white'}`}
            >
              <Icon className="size-4"/>{label}
            </button>
          ))}
        </nav>
        <div>
          {tab === 'profile' && <ProfileForm initialName={user?.name ?? ''} initialEmail={user?.email ?? ''} afterSave={refresh}/>}
          {tab === 'brand' && <BrandForm/>}
          {tab === 'security' && <PasswordForm/>}
          {tab === 'notifications' && <NotificationsForm/>}
        </div>
      </div>
    </>
  );
}

function FormMessage({ message, error }: { message: string; error: boolean }) {
  if (!message) return null;
  return (
    <div className="mb-5">
      {error ? (
        <Alert>{message}</Alert>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/15 bg-emerald-500/[.07] p-3 text-sm text-emerald-200">
          <Check className="size-4"/>{message}
        </div>
      )}
    </div>
  );
}

function ProfileForm({ initialName, initialEmail, afterSave }: { initialName: string; initialEmail: string; afterSave: () => Promise<void> }) {
  const [form, setForm] = useState({ name: initialName, email: initialEmail });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => setForm({ name: initialName, email: initialEmail }), [initialName, initialEmail]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api(endpoints.profile, { method: 'PATCH', body: JSON.stringify(form) });
      await afterSave();
      setFailed(false);
      setMessage('Perfil atualizado.');
    } catch (reason) {
      setFailed(true);
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível atualizar o perfil.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-3xl p-5 sm:p-7">
      <h2 className="text-lg font-bold text-white">Informações pessoais</h2>
      <p className="mt-1 text-sm text-zinc-500">Usamos esses dados para identificar sua conta.</p>
      <form onSubmit={submit} className="mt-7">
        <FormMessage message={message} error={failed}/>
        <div className="grid gap-5 sm:grid-cols-2">
          <div><Label htmlFor="profile-name">Nome</Label><Input id="profile-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></div>
          <div><Label htmlFor="profile-email">E-mail</Label><Input id="profile-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })}/></div>
        </div>
        <div className="mt-6 flex justify-end"><Button disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin"/>}Salvar alterações</Button></div>
      </form>
    </Card>
  );
}

function BrandForm() {
  const [form, setForm] = useState<BrandKitState>({
    name: '',
    primaryColor: '#c9ff42',
    accentColor: '#ffffff',
    fontFamily: 'Inter',
    watermarkText: '',
    logoKey: '',
    watermarkPosition: 'W-tw-32:H-th-32',
    watermarkOpacity: 0.75,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<Partial<BrandKitState> | { data: Partial<BrandKitState> }>(endpoints.brandKit)
      .then((result) => {
        const value = result && 'data' in result ? result.data : result;
        if (value) setForm((current) => ({ ...current, ...value }));
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api(endpoints.brandKit, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          primaryColor: form.primaryColor,
          accentColor: form.accentColor,
          fontFamily: form.fontFamily,
          watermarkText: form.watermarkText,
        }),
      });
      await api('/brand-kits/logo', {
        method: 'POST',
        body: JSON.stringify({
          logoKey: form.logoKey,
          watermarkText: form.watermarkText,
          position: form.watermarkPosition,
          opacity: Number(form.watermarkOpacity),
        }),
      });
      setFailed(false);
      setMessage('Identidade visual salva.');
    } catch (reason) {
      setFailed(true);
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível salvar o brand kit.');
    } finally {
      setBusy(false);
    }
  }

  const currentPosition = positionOptions.find((item) => item.value === form.watermarkPosition) ?? positionOptions.at(-1)!;

  return (
    <Card className="max-w-3xl p-5 sm:p-7">
      <h2 className="text-lg font-bold text-white">Identidade visual</h2>
      <p className="mt-1 text-sm text-zinc-500">Essas definições serão aplicadas aos próximos renders e marcas d’água do plano Free.</p>
      <form onSubmit={submit} className="mt-7 space-y-5">
        <FormMessage message={message} error={failed}/>

        <div className="grid gap-5 sm:grid-cols-2">
          <div><Label htmlFor="brand-name">Nome da marca</Label><Input id="brand-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></div>
          <div><Label htmlFor="brand-font">Fonte principal</Label><Input id="brand-font" value={form.fontFamily} onChange={(event) => setForm({ ...form, fontFamily: event.target.value })} placeholder="Inter, Montserrat, Bebas Neue..."/></div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <ColorInput id="brand-color" label="Cor principal" value={form.primaryColor} onChange={(primaryColor) => setForm({ ...form, primaryColor })}/>
          <ColorInput id="brand-accent" label="Cor de destaque" value={form.accentColor} onChange={(accentColor) => setForm({ ...form, accentColor })}/>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="watermark">Texto da marca d’água</Label>
            <Input id="watermark" value={form.watermarkText} onChange={(event) => setForm({ ...form, watermarkText: event.target.value })}/>
          </div>
          <div>
            <Label htmlFor="logo-key">Logo no storage</Label>
            <div className="relative">
              <ImageIcon className="absolute left-3.5 top-3.5 size-4 text-zinc-600"/>
              <Input id="logo-key" className="pl-10" value={form.logoKey} onChange={(event) => setForm({ ...form, logoKey: event.target.value })} placeholder="brand-kits/logo.png"/>
            </div>
            <p className="mt-2 text-xs text-zinc-600">Por enquanto informe a chave/URL já enviada ao storage.</p>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="watermark-position">Posição da marca</Label>
            <select
              id="watermark-position"
              value={form.watermarkPosition}
              onChange={(event) => setForm({ ...form, watermarkPosition: event.target.value })}
              className="h-11 w-full rounded-xl border border-white/10 bg-white/[.035] px-3.5 text-sm text-white outline-none"
            >
              {positionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="watermark-opacity">Opacidade: {Math.round(form.watermarkOpacity * 100)}%</Label>
            <input
              id="watermark-opacity"
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={form.watermarkOpacity}
              onChange={(event) => setForm({ ...form, watermarkOpacity: Number(event.target.value) })}
              className="h-11 w-full accent-[#c9ff42]"
            />
          </div>
        </div>

        <div className="rounded-xl border border-white/[.07] bg-black p-5">
          <p className="text-xs text-zinc-600">Prévia</p>
          <div className={`mt-3 flex aspect-[16/7] rounded-lg bg-gradient-to-br from-zinc-800 to-zinc-950 p-4 ${currentPosition.className}`}>
            <span
              className="rounded-lg bg-black/35 px-3 py-1 text-sm font-bold"
              style={{ color: form.primaryColor, opacity: form.watermarkOpacity, fontFamily: form.fontFamily || undefined }}
            >
              {form.watermarkText || form.name || 'PicaShorts'}
            </span>
          </div>
        </div>

        <div className="flex justify-end"><Button disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin"/>}Salvar brand kit</Button></div>
      </form>
    </Card>
  );
}

function ColorInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-3">
        <input id={id} type="color" value={value} onChange={(event) => onChange(event.target.value)} className="h-11 w-14 cursor-pointer rounded-xl border border-white/10 bg-panel p-1"/>
        <Input value={value} onChange={(event) => onChange(event.target.value)} pattern="^#[0-9a-fA-F]{6}$"/>
      </div>
    </div>
  );
}

function PasswordForm() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.newPassword !== form.confirmPassword) {
      setFailed(true);
      setMessage('As novas senhas não coincidem.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      await api(endpoints.password, { method: 'PATCH', body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setFailed(false);
      setMessage('Senha alterada com segurança.');
    } catch (reason) {
      setFailed(true);
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível alterar sua senha.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-3xl p-5 sm:p-7">
      <h2 className="text-lg font-bold text-white">Alterar senha</h2>
      <p className="mt-1 text-sm text-zinc-500">Use uma senha exclusiva com 12+ caracteres, maiúscula, minúscula e número.</p>
      <form onSubmit={submit} className="mt-7 max-w-lg space-y-5">
        <FormMessage message={message} error={failed}/>
        <div><Label htmlFor="current-password">Senha atual</Label><Input id="current-password" type="password" required value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}/></div>
        <div><Label htmlFor="new-password">Nova senha</Label><Input id="new-password" type="password" required minLength={12} maxLength={128} pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{12,128}" title="Use pelo menos 12 caracteres, com letra maiúscula, letra minúscula e número." value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })}/></div>
        <div><Label htmlFor="confirm-password">Confirme a nova senha</Label><Input id="confirm-password" type="password" required minLength={12} maxLength={128} pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{12,128}" title="Use pelo menos 12 caracteres, com letra maiúscula, letra minúscula e número." value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })}/></div>
        <Button disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin"/>}Atualizar senha</Button>
      </form>
    </Card>
  );
}

function NotificationsForm() {
  const [values, setValues] = useState({ processing: true, exports: true, billing: true, product: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api<typeof values | { data: typeof values }>('/users/me/notifications')
      .then((result) => setValues('data' in result ? result.data : result))
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      await api('/users/me/notifications', { method: 'PUT', body: JSON.stringify(values) });
      setMessage('Preferências atualizadas.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-3xl p-5 sm:p-7">
      <h2 className="text-lg font-bold text-white">Notificações por e-mail</h2>
      <p className="mt-1 text-sm text-zinc-500">Escolha quando devemos entrar em contato.</p>
      {message && <p className="mt-5 text-sm text-zinc-300">{message}</p>}
      <div className="mt-6 divide-y divide-white/[.06]">
        {[
          ['processing', 'Processamento concluído', 'Quando os cortes de um projeto estiverem prontos.'],
          ['exports', 'Exportação pronta', 'Quando um arquivo estiver disponível para baixar.'],
          ['billing', 'Cobrança e assinatura', 'Recibos, renovação e mudanças no plano.'],
          ['product', 'Novidades do produto', 'Recursos novos e dicas para seus cortes.'],
        ].map(([key, title, text]) => (
          <label key={key} className="flex cursor-pointer items-center justify-between gap-5 py-4">
            <div>
              <p className="text-sm font-medium text-zinc-200">{title}</p>
              <p className="mt-1 text-xs text-zinc-600">{text}</p>
            </div>
            <input
              type="checkbox"
              checked={values[key as keyof typeof values]}
              onChange={(event) => setValues({ ...values, [key]: event.target.checked })}
              className="size-4 accent-[#c9ff42]"
            />
          </label>
        ))}
      </div>
      <div className="mt-5 flex justify-end"><Button onClick={() => void save()} disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin"/>}Salvar preferências</Button></div>
    </Card>
  );
}
