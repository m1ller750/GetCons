import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Logo } from '../components/brand';
import { EmptyState } from '../components/ui';
import { useI18n } from '../lib/i18n';

export function NotFound({ standalone }: { standalone?: boolean }) {
  const { t } = useI18n();
  const body = (
    <EmptyState
      icon={<Compass className="size-6" />}
      title={t.errors.notFound}
      text={t.errors.notFoundText}
      action={
        <Link to="/app" className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
          {t.errors.goHome}
        </Link>
      }
    />
  );
  if (!standalone) return body;
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <Logo />
      {body}
    </div>
  );
}
