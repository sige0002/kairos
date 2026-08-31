// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Bespoke fast_validation result card: a per-required-topic checklist (found ✓
// / missing ✕ + expected msg type) with a PASS/FAIL badge and an "+N extra
// topics" note. fast_validation keeps this purpose-built view because "are my
// required topics there" is the one question it exists to answer; every other
// pipeline lands in the generic SummaryResult instead. The pass/found/missing
// computation lives in resultsMapping.buildChecklist (unit-tested there).
import { Badge, Card, SectionLabel, StatusDot } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import type { Summary } from '../../features/validation/SummaryResult';
import { buildChecklist, type RequiredTopic } from './resultsMapping';

export function ChecklistCard({
  summary,
  required,
}: {
  summary: Summary;
  required: RequiredTopic[];
}) {
  const { t } = useTranslation('validation');
  const { rows, found, total, extraCount, pass } = buildChecklist(summary, required);

  return (
    <Card className="overflow-hidden" data-testid="fast-validation-checklist">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-[18px] py-4">
        <SectionLabel>{t('validationResult')}</SectionLabel>
        <span className="font-mono text-[11.5px] text-text-muted">
          {found}/{total} {t('required')}
        </span>
        <div className="flex-1" />
        <Badge tone={pass ? 'green' : 'red'} dot>
          {pass ? 'PASS' : 'FAIL'}
        </Badge>
      </div>
      <div className="px-[18px] py-1.5">
        <div className="grid grid-cols-[1fr_64px_44px] gap-3 border-b border-border py-2 text-[10px] uppercase tracking-[0.05em] text-text-muted">
          <span>{t('requiredTopics')}</span>
          <span className="text-right">{t('expected')}</span>
          <span className="text-right">{t('result')}</span>
        </div>
        {rows.map((t) => (
          <div
            key={t.name}
            className="grid grid-cols-[1fr_64px_44px] items-center gap-3 border-b border-border py-2.5"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone={t.found ? 'green' : 'red'} />
              <span
                className="truncate font-mono text-[12.5px] text-text-primary"
                title={t.name}
              >
                {t.name}
              </span>
            </span>
            <span className="truncate text-right font-mono text-[10.5px] text-text-muted">
              {t.type ?? 'any'}
            </span>
            <span
              className={`text-right font-mono text-[13px] font-semibold ${
                t.found ? 'text-status-success-text' : 'text-status-danger-text'
              }`}
            >
              {t.found ? '✓' : '✕'}
            </span>
          </div>
        ))}
      </div>
      {extraCount > 0 && (
        <p className="px-[18px] py-2.5 font-mono text-[11px] text-text-muted">
          {t('extraTopics', { count: extraCount })}
        </p>
      )}
    </Card>
  );
}
