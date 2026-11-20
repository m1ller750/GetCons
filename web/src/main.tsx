import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { initSupabase } from './lib/supabase';

const root = createRoot(document.getElementById('root')!);

function Fatal({ message }: { message: string }) {
  const ru = (() => {
    try {
      return localStorage.getItem('getcons.lang') === 'ru';
    } catch {
      return false;
    }
  })();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-card">
        <h1 className="text-lg font-semibold text-slate-900">{ru ? 'Сервер GetCons недоступен' : 'Can’t reach the GetCons server'}</h1>
        <p className="mt-2 text-sm text-slate-500">{message}</p>
        <p className="mt-1 text-sm text-slate-500">
          {ru ? 'Убедитесь, что бэкенд запущен и настроен (см. README).' : 'Make sure the backend is running and configured (see README).'}
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="mt-6 inline-flex h-10 cursor-pointer items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          {ru ? 'Повторить' : 'Try again'}
        </button>
      </div>
    </div>
  );
}

initSupabase()
  .then(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch((err: Error) => root.render(<Fatal message={err.message} />));
