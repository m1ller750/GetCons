import { clsx } from 'clsx';
import {
  BookOpen,
  Check,
  ChevronsUpDown,
  CreditCard,
  FlaskConical,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Plus,
  Settings,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useAuth } from '../lib/auth';
import { phone } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useConsultants, useMe } from '../lib/queries';
import { ConsultantStatusBadge, LanguageSwitch, Logo } from './brand';
import { CreateConsultantForm } from './CreateConsultant';
import { IconButton, Modal } from './ui';

function ConsultantSwitcher({ onCreate }: { onCreate: () => void }) {
  const { consultantId } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const consultants = useConsultants();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = consultants.data?.find((c) => c.id === consultantId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left shadow-card transition-colors hover:border-slate-300"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg brand-gradient text-sm font-semibold text-white">
          {(current?.name ?? '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{current?.name ?? t.nav.consultants}</p>
          <p className="truncate text-xs text-slate-500">
            {current?.business_info.businessName || (current?.telegram_bot_username ? `@${current.telegram_bot_username}` : (current?.whatsapp_phone && phone(current.whatsapp_phone)) || ' ')}
          </p>
        </div>
        <ChevronsUpDown className="size-4 shrink-0 text-slate-400" aria-hidden />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop" role="listbox">
          <p className="px-3 pt-3 pb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">{t.nav.consultants}</p>
          <div className="max-h-72 overflow-y-auto p-1.5 scroll-thin">
            {consultants.data?.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={c.id === consultantId}
                onClick={() => {
                  setOpen(false);
                  navigate(`/app/c/${c.id}`);
                }}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{c.name}</p>
                  <div className="mt-0.5">
                    <ConsultantStatusBadge status={c.status} />
                  </div>
                </div>
                {c.id === consultantId && <Check className="size-4 text-brand-600" aria-hidden />}
              </button>
            ))}
          </div>
          <div className="border-t border-slate-100 p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
            >
              <Plus className="size-4" aria-hidden /> {t.nav.newConsultant}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ onNavigate, onCreate }: { onNavigate?: () => void; onCreate: () => void }) {
  const { consultantId } = useParams();
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const plan = useMe().data?.plan?.id;
  const base = `/app/c/${consultantId}`;
  const items: { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; badge?: string | null }[] = [
    { to: base, label: t.nav.overview, icon: LayoutDashboard, end: true },
    { to: `${base}/conversations`, label: t.nav.conversations, icon: MessagesSquare },
    { to: `${base}/knowledge`, label: t.nav.knowledge, icon: BookOpen },
    { to: `${base}/training`, label: t.nav.training, icon: GraduationCap },
    { to: `${base}/agent`, label: t.nav.agent, icon: Workflow, badge: plan === 'pro' || plan === 'max' ? null : 'Pro' },
    { to: `${base}/playground`, label: t.nav.playground, icon: FlaskConical },
    { to: `${base}/settings`, label: t.nav.settings, icon: Settings },
  ];

  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <div className="px-1 pt-1">
        <Logo to="/app" />
      </div>
      {consultantId && <ConsultantSwitcher onCreate={onCreate} />}
      <nav className="flex flex-col gap-0.5" aria-label="Main">
        {consultantId &&
          items.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                clsx(
                  'flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              <Icon className="size-[18px]" aria-hidden />
              <span className="flex-1">{label}</span>
              {badge && <span className="rounded border border-slate-300 px-1.5 text-[11px] font-semibold tracking-wide text-slate-500">{badge}</span>}
            </NavLink>
          ))}
      </nav>
      <div className="mt-auto space-y-3 border-t border-slate-200 pt-4">
        <NavLink
          to="/app/billing"
          onClick={onNavigate}
          className={({ isActive }) =>
            clsx(
              'flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )
          }
        >
          <CreditCard className="size-[18px]" aria-hidden />
          <span className="flex-1">{t.nav.billing}</span>
          {plan && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{t.billing.plans[plan].name}</span>}
        </NavLink>
        <LanguageSwitch />
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm text-slate-600" title={user?.email ?? ''}>
            {user?.email}
          </p>
          <IconButton label={t.auth.signOut} onClick={() => void signOut()}>
            <LogOut className="size-[18px]" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh lg:pl-72">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-slate-200 bg-slate-50/80 backdrop-blur lg:block">
        <Sidebar onCreate={() => setCreating(true)} />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-3 backdrop-blur lg:hidden">
        <IconButton label={t.nav.menu} onClick={() => setMobileOpen(true)}>
          <Menu className="size-5" />
        </IconButton>
        <Logo to="/app" />
        <LanguageSwitch compact />
      </header>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[85%] max-w-xs bg-slate-50 shadow-pop">
            <IconButton label={t.common.close} className="absolute top-3 right-3" onClick={() => setMobileOpen(false)}>
              <X className="size-5" />
            </IconButton>
            <Sidebar onNavigate={() => setMobileOpen(false)} onCreate={() => setCreating(true)} />
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <Outlet />
      </main>

      <Modal open={creating} onClose={() => setCreating(false)} title={t.create.title} description={t.create.subtitle} size="lg">
        <CreateConsultantForm onCreated={() => setCreating(false)} />
      </Modal>
    </div>
  );
}
