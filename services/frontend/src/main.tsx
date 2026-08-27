// FIRST import on purpose: repairs an Intl-invalid navigator.language
// ("en-US@posix") before any module — uPlot via App's import chain — reads it
// at module scope and blanks the console with a RangeError.
import './localeGuard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppearanceProvider } from './theme';
import { I18nProvider } from './i18n';
import './index.css';

// Defaults tuned for this app's constant SSE-fed + short-poll traffic: don't
// refetch every query on every window focus (the SSE stream keeps caches fresh),
// and retry a failed fetch once rather than the react-query default of 3 — a
// single retry recovers transient blips without hammering. Individual queries
// still override these explicitly (e.g. the SSE-only caches disable fetching).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <I18nProvider>
      <AppearanceProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </ErrorBoundary>
      </AppearanceProvider>
    </I18nProvider>
  </StrictMode>,
);
