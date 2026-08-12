// Bespoke fast_validation result card: a per-required-topic checklist (found ✓
// / missing ✕ + expected msg type) with a PASS/FAIL badge and an "+N extra
// topics" note. fast_validation keeps this purpose-built view because "are my
// required topics there" is the one question it exists to answer; every other
// pipeline lands in the generic SummaryResult instead. The pass/found/missing
// computation lives in resultsMapping.buildChecklist (unit-tested there).
import { Badge, Card, SectionLabel, StatusDot } from '../../components/ui';
import type { Summary } from '../../features/validation/SummaryResult';
import { buildChecklist, type RequiredTopic } from './resultsMapping';

export function ChecklistCard({
  summary,
  required,
}: {
  summary: Summary;
  required: RequiredTopic[];
}) {
  const { rows, found, total, extraCount, pass } = buildChecklist(summary, required);

  return (
    <Card className="overflow-hidden" data-testid="fast-validation-checklist">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Validation result</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-500">
          {found}/{total} required
        </span>
        <div className="flex-1" />
        <Badge tone={pass ? 'green' : 'red'} dot>
          {pass ? 'PASS' : 'FAIL'}
        </Badge>
      </div>
      <div className="px-[18px] py-1.5">
        <div className="grid grid-cols-[1fr_64px_44px] gap-3 border-b border-gray-100 py-2 text-[10px] uppercase tracking-[0.05em] text-gray-500">
          <span>Required topics</span>
          <span className="text-right">Expected</span>
          <span className="text-right">Result</span>
        </div>
        {rows.map((t) => (
          <div
            key={t.name}
            className="grid grid-cols-[1fr_64px_44px] items-center gap-3 border-b border-gray-50 py-2.5"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone={t.found ? 'green' : 'red'} />
              <span className="truncate font-mono text-[12.5px] text-gray-700" title={t.name}>
                {t.name}
              </span>
            </span>
            <span className="truncate text-right font-mono text-[10.5px] text-gray-500">
              {t.type ?? 'any'}
            </span>
            <span
              className={`text-right font-mono text-[13px] font-semibold ${
                t.found ? 'text-green-700' : 'text-red-600'
              }`}
            >
              {t.found ? '✓' : '✕'}
            </span>
          </div>
        ))}
      </div>
      {extraCount > 0 && (
        <p className="px-[18px] py-2.5 font-mono text-[11px] text-gray-500">
          +{extraCount} extra topics not required
        </p>
      )}
    </Card>
  );
}
