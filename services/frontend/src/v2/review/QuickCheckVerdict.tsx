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
import { useTranslation } from 'react-i18next';

/**
 * Link a server-written quick-check reason to a topic without treating the
 * English reason text as an API.  The server already supplies the topic names
 * in the two structured layers; a reason can only be focused when one of
 * those names occurs in it.  This keeps an unrecognised future reason useful
 * (it still opens the loss section) rather than inventing a topic from copy.
 */
export function topicForQuickCheckReason(
  reason: string,
  quickCheck: QuickCheck,
): string | null {
  const layer0Topics = Object.keys(quickCheck.layer0?.topics ?? {});
  const layer1Topics = Object.keys(quickCheck.layer1?.topics ?? {});
  const layer1Declared = [
    ...(quickCheck.layer1?.missing_topics ?? []),
    ...(quickCheck.layer1?.empty_topics ?? []),
  ];
  return (
    [...new Set([...layer0Topics, ...layer1Topics, ...layer1Declared])]
      // A topic may be a prefix of another topic.  Prefer the longest exact
      // name present in the reason, so the focused evidence is not broadened.
      .sort((a, b) => b.length - a.length)
      .find((topic) => reason.includes(topic)) ?? null
  );
}

export function QuickCheckVerdict({
  quickCheck,
  onInspectGaps,
}: {
  quickCheck?: QuickCheck | null;
  /** Opens the manual loss-report evidence for a reason. Never starts a job. */
  onInspectGaps?: (topic: string | null) => void;
}) {
  const { t } = useTranslation('review');
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
      className={`flex flex-col gap-2 rounded-[10px] border px-3 py-3 ${
        quality === 'needs_review'
          ? 'border-status-warning-border bg-status-warning-bg'
          : quality === 'good'
            ? 'border-status-success-border bg-status-success-bg'
            : 'border-border bg-surface-muted'
      }`}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('quickCheck')}
        </h3>
        {quality && (
          <Badge tone={quality === 'good' ? 'green' : 'amber'} dot>
            {quality === 'good' ? t('quickCheckGood') : t('quickCheckNeedsReview')}
          </Badge>
        )}
      </div>

      {reasons.length > 0 ? (
        <ul data-testid="review-quick-check-reasons" className="flex flex-col gap-1">
          {reasons.map((r, i) => (
            <li
              key={`${i}:${r}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span className="text-[11.5px] leading-snug text-status-warning-text">
                • {r}
              </span>
              {quality === 'needs_review' && onInspectGaps && (
                <button
                  type="button"
                  data-testid={`review-quick-check-inspect-${i}`}
                  onClick={() => onInspectGaps(topicForQuickCheckReason(r, quickCheck))}
                  className="rounded-control border border-status-warning-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-status-warning-text hover:bg-status-warning-bg"
                >
                  {(() => {
                    const topic = topicForQuickCheckReason(r, quickCheck);
                    return topic
                      ? t('quickCheckInspectTopic', { topic })
                      : t('quickCheckInspectGaps');
                  })()}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : quality === 'good' ? (
        <span className="text-[11.5px] text-text-muted">{t('quickCheckNoIssues')}</span>
      ) : null}

      {quality && (
        <p
          data-testid="review-quick-check-next-step"
          className="text-[11.5px] leading-snug text-text-secondary"
        >
          {quality === 'needs_review'
            ? t('quickCheckInspectionRecommended')
            : t('quickCheckInspectionOptional')}
        </p>
      )}

      {(layer0Down || layer1Down) && (
        <div
          data-testid="review-quick-check-unavailable"
          className="flex flex-col gap-0.5 text-[11px] text-text-muted"
        >
          {layer0Down && <span>{t('quickCheckMonitorUnavailable')}</span>}
          {layer1Down && <span>{t('quickCheckBagSummaryMissing')}</span>}
        </div>
      )}
    </section>
  );
}
