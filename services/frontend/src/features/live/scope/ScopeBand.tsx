// Live Scope band (OL-③.2 successor): a full-width, collapsible band below the
// [Stream | Monitor] grid, hosting add-style Health/Signal panels (see
// docs/specs/ja/frontend.md's Live tab section). State (open/window/panels)
// lives in the Zustand uiStore so it survives a Live tab unmount on tab switch.
//
// Panels — and the data hooks they own (a Signal panel opens its own
// topic_probe SSE streams) — are only rendered while the band is expanded:
// collapsing it unmounts every panel, closing any open Signal streams;
// re-expanding remounts them from the persisted store state.

import { useEffect, useState } from 'react';
import { SectionLabel, cn } from '../../../components/ui';
import { useUiStore, type ScopeWindowId } from '../../../store/uiStore';
import type { MetricSample } from '../../graph/useMetricHistory';
import type { ChartMarker } from '../../probe/UplotChart';
import { ScopePanel } from './ScopePanel';

const WINDOWS: { id: ScopeWindowId; label: string; sec: number }[] = [
  { id: '30s', label: '30s', sec: 30 },
  { id: '1m', label: '1m', sec: 60 },
  { id: '5m', label: '5m', sec: 300 },
];

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('shrink-0 transition-transform', open && 'rotate-180')}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PanelCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="font-mono text-[11px] text-gray-400">
      {count} panel{count > 1 ? 's' : ''}
    </span>
  );
}

export function ScopeBand({
  history,
  topics,
  markers,
}: {
  history: Map<string, MetricSample[]>;
  topics: string[];
  markers: ChartMarker[];
}) {
  const open = useUiStore((s) => s.scopeOpen);
  const setOpen = useUiStore((s) => s.setScopeOpen);
  const windowId = useUiStore((s) => s.scopeWindowId);
  const setWindow = useUiStore((s) => s.setScopeWindow);
  const panels = useUiStore((s) => s.scopePanels);
  const addHealthPanel = useUiStore((s) => s.addHealthPanel);
  const addSignalPanel = useUiStore((s) => s.addSignalPanel);
  const removeScopePanel = useUiStore((s) => s.removeScopePanel);
  const updateScopePanel = useUiStore((s) => s.updateScopePanel);

  const windowSec = WINDOWS.find((w) => w.id === windowId)?.sec ?? 60;
  const count = panels.length;

  // 1 Hz clock so a Health panel's alignment window scrolls smoothly between
  // SSE snapshots (mirrors the Graph tab). Only ticks while expanded — no
  // panels are mounted to redraw while collapsed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="toggle scope"
        className="flex h-9 w-full shrink-0 items-center gap-2.5 rounded-control border border-gray-200 bg-white px-[18px] text-left hover:bg-gray-50"
      >
        <SectionLabel>Scope</SectionLabel>
        <PanelCount count={count} />
        <div className="flex-1" />
        <Chevron open={false} />
      </button>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-2.5 rounded-card border border-gray-200 bg-white p-3 lg:h-[38vh]">
      <div className="flex flex-wrap items-center gap-2.5">
        <SectionLabel>Scope</SectionLabel>
        <PanelCount count={count} />
        <button
          type="button"
          aria-label="add health panel"
          onClick={() => addHealthPanel()}
          className="rounded-control border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          + Health
        </button>
        <button
          type="button"
          aria-label="add signal panel"
          onClick={() => addSignalPanel()}
          className="rounded-control border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          + Signal
        </button>
        <div className="flex-1" />
        <div className="flex gap-[3px] rounded-control border border-gray-200 bg-gray-100 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={w.id === windowId}
              onClick={() => setWindow(w.id)}
              className={cn(
                'rounded-chip px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                w.id === windowId
                  ? 'bg-white text-teal-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="toggle scope"
          className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100"
        >
          <Chevron open />
        </button>
      </div>

      {count === 0 ? (
        <p className="flex flex-1 items-center justify-center text-center text-[11.5px] text-gray-400">
          Add a Health or Signal panel to start plotting.
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-2">
          {panels.map((panel) => (
            <ScopePanel
              key={panel.id}
              panel={panel}
              topics={topics}
              history={history}
              windowSec={windowSec}
              now={now}
              markers={markers}
              onUpdate={(patch) => updateScopePanel(panel.id, patch)}
              onRemove={() => removeScopePanel(panel.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
