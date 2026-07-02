// Root error boundary: React unmounts the whole tree if a render throws, so a
// single malformed SSE/API payload that slips past a component's own guards
// would otherwise white-out the entire UI. This catches it, keeps the shell
// alive, and offers a reload. Class component because error boundaries have no
// hook equivalent (componentDidCatch / getDerivedStateFromError only).

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it in the console for debugging; the UI shows a recovery card.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md rounded-card border border-gray-200 bg-white p-6 shadow-card">
          <h1 className="text-[15px] font-semibold text-gray-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-gray-600">
            The interface hit an unexpected error and stopped rendering. Reloading
            usually recovers it.
          </p>
          {error.message && (
            <pre className="mt-3 overflow-x-auto rounded-control border border-gray-100 bg-gray-50 p-3 font-mono text-[11.5px] text-red-700">
              {error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center justify-center rounded-control bg-teal-600 px-4 py-2 text-sm font-semibold text-white shadow-btn transition-colors hover:bg-teal-700"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
