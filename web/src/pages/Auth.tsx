import { MailCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LanguageSwitch, Logo } from '../components/brand';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { fmt, useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';

type Mode = 'signin' | 'signup' | 'forgot';

/** The confirmation link signs the user in and opens the dashboard. */
const confirmRedirect = () => `${window.location.origin}/app`;

/** Supabase auth errors in the user's language (falls back to Supabase's own text). */
function authMessage(err: unknown, t: ReturnType<typeof useI18n>['t']): string {
  switch ((err as { code?: string }).code) {
    case 'over_email_send_rate_limit':
      return t.auth.emailRateLimited;
    case 'email_address_not_authorized':
    case 'email_address_invalid':
      return t.auth.emailNotSent;
    case 'user_already_exists':
      return t.auth.emailTaken;
    default:
      return (err as Error).message;
  }
}

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-paper">
      <header className="relative flex items-center justify-between px-5 py-4 sm:px-8">
        <Logo />
        <LanguageSwitch />
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:pt-12">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-1.5 text-[15px] text-slate-500">{subtitle}</p>
          </div>
          <Card className="p-6 sm:p-8">{children}</Card>
        </div>
      </main>
    </div>
  );
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Address that is waiting for its confirmation email (offers "send again").
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/app';

  const waitForConfirmation = (address: string, text: string) => {
    setUnconfirmed(address);
    setNotice(text);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const auth = supabase().auth;
      if (mode === 'signin') {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error?.code === 'email_not_confirmed') return waitForConfirmation(email, fmt(t.auth.notConfirmed, { email }));
        if (error) throw error;
        navigate(from, { replace: true });
      } else if (mode === 'signup') {
        const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: confirmRedirect() } });
        if (error) throw error;
        // Email confirmation turned off in Supabase: the account is ready right away.
        if (data.session) return navigate('/app', { replace: true });
        // Same answer whether or not the email is registered, so nobody can probe for customers' emails.
        waitForConfirmation(email, fmt(t.auth.checkEmail, { email }));
      } else {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
        if (error) throw error;
        setNotice(t.auth.resetSent);
      }
    } catch (err) {
      setError(authMessage(err, t));
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (!unconfirmed) return;
    setResending(true);
    const { error } = await supabase().auth.resend({ type: 'signup', email: unconfirmed, options: { emailRedirectTo: confirmRedirect() } });
    setResending(false);
    if (error) toast.error(authMessage(error, t));
    else toast.success(t.auth.resent);
  };

  const copy = {
    signin: { title: t.auth.signInTitle, subtitle: t.auth.signInSubtitle, button: t.auth.signIn },
    signup: { title: t.auth.signUpTitle, subtitle: t.auth.signUpSubtitle, button: t.auth.signUp },
    forgot: { title: t.auth.resetTitle, subtitle: t.auth.resetSubtitle, button: t.auth.sendReset },
  }[mode];

  return (
    <AuthLayout title={copy.title} subtitle={copy.subtitle}>
      {notice ? (
        <div className="space-y-5 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
            <MailCheck className="size-6" aria-hidden />
          </div>
          <p className="text-sm text-slate-600">{notice}</p>
          {unconfirmed && (
            <>
              <p className="text-xs text-slate-500">{t.auth.checkSpam}</p>
              {mode === 'signup' && <p className="text-xs text-slate-500">{t.auth.alreadyRegistered}</p>}
              <Button variant="secondary" className="w-full" loading={resending} onClick={resend}>
                {t.auth.resend}
              </Button>
            </>
          )}
          <Link
            to="/login"
            onClick={() => {
              setNotice(null);
              setUnconfirmed(null);
            }}
            className="block text-sm font-medium text-brand-700 hover:underline"
          >
            {t.auth.backToSignIn}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate={false}>
          {error && <Alert tone="error">{error}</Alert>}
          <Field label={t.auth.email}>
            {(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
          </Field>
          {mode !== 'forgot' && (
            <Field
              label={t.auth.password}
              hint={mode === 'signup' ? t.auth.passwordHint : undefined}
              aside={
                mode === 'signin' ? (
                  <Link to="/forgot-password" className="text-sm text-brand-700 hover:underline">
                    {t.auth.forgot}
                  </Link>
                ) : undefined
              }
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  required
                  minLength={mode === 'signup' ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
          )}
          <Button type="submit" size="lg" className="w-full" loading={loading}>
            {copy.button}
          </Button>
          <p className="pt-1 text-center text-sm text-slate-500">
            {mode === 'signin' ? (
              <>
                {t.auth.noAccount}{' '}
                <Link to="/signup" className="font-medium text-brand-700 hover:underline">
                  {t.auth.signUp}
                </Link>
              </>
            ) : (
              <>
                {mode === 'signup' && `${t.auth.haveAccount} `}
                <Link to="/login" className="font-medium text-brand-700 hover:underline">
                  {mode === 'signup' ? t.auth.signIn : t.auth.backToSignIn}
                </Link>
              </>
            )}
          </p>
        </form>
      )}
    </AuthLayout>
  );
}

/** Landing page for the password-recovery email link (Supabase signs the user in temporarily). */
export function ResetPasswordPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase().auth.updateUser({ password });
    setLoading(false);
    if (error) return setError(error.message);
    toast.success(t.auth.passwordUpdated);
    navigate('/app', { replace: true });
  };

  return (
    <AuthLayout title={t.auth.newPasswordTitle} subtitle={t.auth.passwordHint}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label={t.auth.newPassword}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          {t.auth.updatePassword}
        </Button>
      </form>
    </AuthLayout>
  );
}
