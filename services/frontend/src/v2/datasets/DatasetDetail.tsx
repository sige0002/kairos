// Center column: the selected dataset's recipe summary, stats, operator
// breakdown and condition coverage — the detail content that switches when a
// different card is picked in DatasetList.

import { Badge } from '../../components/ui';
import { COVERAGE, OPERATOR_ROWS } from './data';
import type { DatasetsState } from './useDatasetsState';

const INFO_CARDS = [
  { title: '① RECIPE', body: 'Define a query over Review: task, operators, conditions, adopted only…' },
  { title: '② BUILD', body: 'Matching episodes are converted from MCAP to LeRobot v3 format.' },
  { title: '③ ARTIFACT', body: 'A versioned, reproducible output — ready for training, traceable to source.' },
];

export function DatasetDetail({ state }: { state: DatasetsState }) {
  const { ds } = state;
  return (
    <div className="flex min-w-0 flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]">
        <span data-testid="dataset-detail-name" className="text-[15px] font-bold text-gray-900">
          {ds.name}
        </span>
        <span data-testid="dataset-detail-version">
          <Badge tone="teal" mono>
            {ds.ver}
          </Badge>
        </span>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">recipe locked · built 2026-05-15</span>
      </div>
      <div className="flex flex-col gap-4 px-[18px] py-4">
        <div className="grid grid-cols-3 gap-2">
          {INFO_CARDS.map((c) => (
            <div
              key={c.title}
              className="flex flex-col gap-[3px] rounded-[11px] border border-gray-100 bg-gray-50 px-[13px] py-[10px]"
            >
              <span className="text-[11px] font-bold text-teal-700">{c.title}</span>
              <span className="text-[11.5px] leading-[1.45] text-gray-500">{c.body}</span>
            </div>
          ))}
        </div>

        <span className="text-[13px] leading-relaxed text-gray-500">{ds.desc}</span>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Grouped by
          </span>
          <Badge tone="teal">Task: Pick and Place</Badge>
          <Badge tone="teal">Operators: {ds.ops}</Badge>
          <Badge tone="gray">{ds.cond}</Badge>
          <a
            role="link"
            tabIndex={0}
            data-testid="edit-recipe-link"
            onClick={state.toastEditRecipe}
            onKeyDown={(e) => {
              if (e.key === 'Enter') state.toastEditRecipe();
            }}
            className="cursor-pointer text-xs font-semibold text-gray-900 hover:text-teal-700"
          >
            Edit recipe →
          </a>
        </div>

        <div className="grid grid-cols-4 gap-2" data-testid="dataset-stats">
          <Stat value={ds.eps} label="episodes included" color="text-gray-900" />
          <Stat value={ds.success} label="success" color="text-green-600" />
          <Stat value={ds.fail} label="failure" color="text-red-600" />
          <Stat value={ds.review} label="needs review" color="text-amber-600" />
        </div>

        <div className="flex flex-col gap-[7px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Episodes by operator
          </span>
          {OPERATOR_ROWS.map((o) => (
            <div key={o.name} className="flex items-center gap-2.5">
              <span className="w-[92px] text-[12.5px] text-gray-700">{o.name}</span>
              <div className="h-[10px] flex-1 overflow-hidden rounded-[5px] bg-gray-100">
                <span
                  className="block h-full rounded-[5px] bg-teal-600"
                  style={{ width: `${o.pct}%`, opacity: o.opacity }}
                />
              </div>
              <span className="w-[44px] text-right font-mono text-xs text-gray-500">{o.count}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Condition coverage
            </span>
            <div className="flex-1" />
            <span className="text-[11.5px] font-semibold text-amber-600">
              ⚠ Right→Center underrepresented
            </span>
          </div>
          <div className="flex h-[110px] items-end gap-[18px] border-b border-gray-100 px-1.5">
            {COVERAGE.map((b) => (
              <div key={b.label} className="flex h-full flex-1 flex-col items-center justify-end gap-[5px]">
                <span className="font-mono text-[11px] text-gray-500">{b.count}</span>
                <div
                  className="w-full max-w-[46px] rounded-t-md"
                  style={{ height: `${b.pct}%`, background: b.warn ? '#fbbf24' : '#0d9488', opacity: b.warn ? 1 : 0.85 }}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-[18px] px-1.5">
            {COVERAGE.map((b) => (
              <span key={b.label} className="flex-1 text-center text-[11px] text-gray-400">
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[11px] border border-gray-100 px-[14px] py-[11px]">
      <span className={`font-mono text-[21px] font-semibold ${color}`}>{value}</span>
      <span className="text-[11.5px] text-gray-400">{label}</span>
    </div>
  );
}
