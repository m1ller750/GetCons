import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { AppShell } from './components/AppShell';
import { ConfirmProvider, PageLoader } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { AppHome } from './pages/AppHome';
import { AuthPage, ResetPasswordPage } from './pages/Auth';
import { LandingPage } from './pages/Landing';
import { NotFound } from './pages/NotFound';

// Dashboard pages are code-split so the landing page stays light.
const page = (load: () => Promise<Record<string, unknown>>, name: string) => async () => ({
  Component: (await load())[name] as React.ComponentType,
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, recovering } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (recovering) return <Navigate to="/reset-password" replace />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (session) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <GuestOnly><AuthPage mode="signin" /></GuestOnly> },
  { path: '/signup', element: <GuestOnly><AuthPage mode="signup" /></GuestOnly> },
  { path: '/forgot-password', element: <GuestOnly><AuthPage mode="forgot" /></GuestOnly> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <AppHome /> },
      { path: 'c/:consultantId', lazy: page(() => import('./pages/Overview'), 'OverviewPage') },
      { path: 'c/:consultantId/conversations', lazy: page(() => import('./pages/Conversations'), 'ConversationsPage') },
      { path: 'c/:consultantId/knowledge', lazy: page(() => import('./pages/Knowledge'), 'KnowledgePage') },
      { path: 'c/:consultantId/training', lazy: page(() => import('./pages/Training'), 'TrainingPage') },
      { path: 'c/:consultantId/playground', lazy: page(() => import('./pages/Playground'), 'PlaygroundPage') },
      { path: 'c/:consultantId/agent', lazy: page(() => import('./pages/Agent'), 'AgentPage') },
      { path: 'c/:consultantId/settings', lazy: page(() => import('./pages/Settings'), 'SettingsPage') },
      { path: 'billing', lazy: page(() => import('./pages/Billing'), 'BillingPage') },
      { path: '*', element: <NotFound /> },
    ],
  },
  { path: '*', element: <NotFound standalone /> },
]);

export function App() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
            <Toaster position="top-right" richColors closeButton />
          </ConfirmProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
