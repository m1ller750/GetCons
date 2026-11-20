import { LogoMark } from '../components/brand';
import { Navigate } from 'react-router';
import { CreateConsultantForm } from '../components/CreateConsultant';
import { Alert, Card, PageLoader } from '../components/ui';
import { errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useConsultants } from '../lib/queries';

/** First stop after sign-in: open the first consultant, or offer one-click creation. */
export function AppHome() {
  const { t } = useI18n();
  const consultants = useConsultants();
  if (consultants.isLoading) return <PageLoader />;
  if (consultants.error) return <Alert tone="error" title={t.common.error}>{errorText(consultants.error)}</Alert>;
  const first = consultants.data?.[0];
  if (first) return <Navigate to={`/app/c/${first.id}`} replace />;

  return (
    <div className="mx-auto max-w-2xl py-4 lg:py-10">
      <div className="mb-8 text-center">
        <LogoMark className="mx-auto mb-5 size-14" />
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{t.create.title}</h1>
        <p className="mx-auto mt-2 max-w-lg text-[15px] text-slate-500">{t.create.subtitle}</p>
      </div>
      <Card className="p-6 sm:p-8">
        <CreateConsultantForm />
      </Card>
    </div>
  );
}
