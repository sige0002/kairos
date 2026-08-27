// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Quick-check verdict for the Review detail: the "why is this needs_review"
// answer surfaced inline, so nobody has to open the JSON sidecar to learn it
// (persona OP2's friction). Renders NOTHING when the run has no quick_check
// (recorded before the feature) — no fabricated state. A layer that couldn't be
// read (live monitor down at stop, or a missing bag summary) is stated as
// honestly unavailable with the plain-language reason.

import type { QuickCheck } from '../../api/types';
import { Badge } from '../../components/ui';

export function QuickCheckVerdict({ quickCheck }: { quickCheck?: QuickCheck | null }) {
  if (!quickCheck) return null;
  const { verdict, layer0, layer1 } = quickCheck;
  const quality = verdict?.quality;
  const reasons = verdict?.reasons ?? [];

  const layer0Down = !!layer0 && layer0.available === false;
  const layer1Down =
    !!layer1 && (layer1.available === false || layer1.summary_available === false);

  return (
    <section
      data-testid="review-quick-check"
      className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface-muted px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Quick check
        </h3>
        {quality && (
          <Badge tone={quality === 'good' ? 'green' : 'amber'} dot>
            {quality === 'good' ? 'GOOD' : 'NEEDS REVIEW'}
          </Badge>
        )}
      </div>

      {reasons.length > 0 ? (
        <ul data-testid="review-quick-check-reasons" className="flex flex-col gap-0.5">
          {reasons.map((r, i) => (
            <li
              key={`${i}:${r}`}
              className="text-[11.5px] leading-snug text-status-warning-text"
            >
              • {r}
            </li>
          ))}
        </ul>
      ) : quality === 'good' ? (
        <span className="text-[11.5px] text-text-muted">No issues found.</span>
      ) : null}

      {(layer0Down || layer1Down) && (
        <div
          data-testid="review-quick-check-unavailable"
          className="flex flex-col gap-0.5 text-[11px] text-text-muted"
        >
          {layer0Down && <span>Monitor data unavailable at stop.</span>}
          {layer1Down && (
            <span>Bag summary missing — recording may have ended uncleanly.</span>
          )}
        </div>
      )}
    </section>
  );
}
