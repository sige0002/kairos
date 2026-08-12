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

/**
 * A boundary around ONE tab panel, so a screen that throws costs the screen.
 *
 * The root boundary above is the last resort, and as the last resort it is
 * brutal: it replaces the whole document, tab bar included. E-23 measured what
 * that means in practice — one malformed SSE metrics event (well-formed JSON,
 * a wrong-shaped field) took the entire console down for an operator who was on
 * Collect and had never opened Monitor, left them unable to switch tabs, and
 * never recovered, because nothing clears `state.error` but a page reload.
 *
 * Scoped here, the shell survives, which matters for two reasons: the tab bar
 * IS the operator's way out, and leaving the tab resets this boundary — the
 * `resetKey` change clears the error, so recovery costs a click instead of a
 * reload and whatever was in flight elsewhere is not thrown away.
 */
export class PanelBoundary extends Component<
  Props & { resetKey?: string; standalone?: boolean },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props & { resetKey?: string; standalone?: boolean }): void {
    // Left the panel that broke: give the next one a clean boundary.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Panel error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="panel-error"
        className="flex h-full min-h-[240px] items-center justify-center p-6"
      >
        <div className="w-full max-w-md rounded-card border border-red-200 bg-white p-6 shadow-card">
          {/* h1, not h2: this fallback REPLACES the screen, and the screen's
              own ScreenTitle h1 unmounts with it. An h2 here would leave the
              document with no h1 at all — the exact gap #14 closed — so the
              thing that is actually on screen titles it, matching the root
              ErrorBoundary's h1 above. */}
          <h1 className="text-[15px] font-semibold text-gray-900">
            This screen stopped rendering
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            Something it was given could not be displayed.{' '}
            {/* A popped-out window has no tab bar and a constant `resetKey`, so
                the recovery the shell offers does not exist here — promising it
                would send the operator hunting for tabs that are not on the
                page. */}
            {this.props.standalone
              ? 'This window shows only this screen, so reloading it is the way back.'
              : 'The rest of the console is unaffected — switching tabs and coming back reloads this screen.'}
          </p>
          {error.message && (
            <pre className="mt-3 overflow-x-auto rounded-control border border-gray-100 bg-gray-50 p-3 font-mono text-[11.5px] text-red-700">
              {error.message}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
