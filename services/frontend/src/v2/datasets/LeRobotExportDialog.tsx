// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Convert the selected dataset to LeRobot v3 (§6.2).
//
// The dialog has two faces, like the dataset archive's, for the same reason:
// the commitment and the run it starts are different things to look at.
//
//   FORM     — the profile, the memo that names the output, the fallback task
//              when some capture has none, and — above all — the PREFLIGHT:
//              what would actually be converted, what would be left out and
//              why, and where it would land. A conversion that can only fail
//              is visible here, before anything runs.
//   PROGRESS — episodes done out of total, composed with the current episode's
//              own percentage so a long episode still moves the bar, plus the
//              exporter's stall signal and a Cancel.
//
// What this dialog deliberately does NOT offer:
//
//   * fps / split / resampling. Those are properties of the profile; a
//     different recipe is a different profile, chosen from the library, not a
//     field edited per run (2026-08-13 ruling).
//   * per-episode task editing. The capture label editor is the one place task
//     labels are set, and a second one here would be a second answer.

import { Badge, Button, Modal } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { useTranslation } from 'react-i18next';
import { useRecordStatus } from '../captures/useRecordStatus';
import { shortCaptureId } from './data';
import type { ExportProfile } from '../../api/types';
import type { LeRobotExportState } from './useLeRobotExport';

const FIELD_LABEL =
  'text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted';
const FIELD_INPUT =
  'rounded-control border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text-primary';

function exportStateLabel(
  t: (
    key:
      | 'exportStateQueued'
      | 'exportStateRunning'
      | 'exportStateComplete'
      | 'exportStateCanceled'
      | 'exportStateFailed',
  ) => string,
  state: string,
): string {
  switch (state) {
    case 'queued':
      return t('exportStateQueued');
    case 'running':
      return t('exportStateRunning');
    case 'complete':
      return t('exportStateComplete');
    case 'canceled':
      return t('exportStateCanceled');
    default:
      return t('exportStateFailed');
  }
}

/** What a profile says about itself, in one line — and, when it does not
 *  validate, exactly what the loader said instead.
 *
 *  `valid: null` is its own answer, and never a pass: the profile is there but
 *  nothing checked it. WHY nothing checked it is a property of the exporter,
 *  not of the profile (`validator_unavailable`), so when the server tells us
 *  that, the line says it — an unexplained "not verified" is the kind of
 *  hedge an operator reads as noise and stops seeing. */
function ProfileInfo({
  profile,
  validatorUnavailable,
}: {
  profile: ExportProfile;
  validatorUnavailable: boolean;
}) {
  const { t } = useTranslation('datasets');
  const facts: string[] = [];
  if (profile.fps != null) facts.push(`${profile.fps} fps`);
  if (profile.topics?.length) facts.push(`${profile.topics.length} topics`);
  if (profile.source) facts.push(profile.source);
  return (
    <>
      <span
        data-testid="lerobot-export-profile-info"
        className="text-[11px] text-text-muted"
      >
        {profile.valid === true && (
          <span className="text-accent">{t('profileValid')}</span>
        )}
        {profile.valid == null && (
          <span className="text-status-warning-text">
            {validatorUnavailable
              ? t('profileConverterUnavailable')
              : t('profileUnverified')}
          </span>
        )}
        {profile.valid === false && (
          <span className="text-status-danger-text font-semibold">
            {t('profileInvalid')}
          </span>
        )}
        {facts.length > 0 && <> · {facts.join(' · ')}</>}
      </span>
      {profile.valid === false && (
        <ul
          data-testid="lerobot-export-profile-errors"
          className="flex flex-col gap-0.5 rounded-control border border-status-danger-border bg-status-danger-bg px-2.5 py-1.5 text-[11.5px] leading-relaxed text-status-danger-text"
        >
          {(profile.errors ?? [t('converterNoReason')]).map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The label distribution, when there is more than one answer among the
 *  members — "pick x30 · pour x12 · 3 unlabeled". With a single label and
 *  nothing missing there is nothing to disambiguate, so nothing is said. */
function TaskSummary({ state }: { state: LeRobotExportState }) {
  const { t } = useTranslation('datasets');
  const tasks = state.preflight?.tasks;
  if (!tasks) return null;
  const values = Object.entries(tasks.values);
  if (values.length <= 1 && tasks.unlabeled === 0) return null;
  return (
    <p data-testid="lerobot-export-tasks" className="text-[11.5px] text-text-secondary">
      {t('exportTaskLabels')}{' '}
      {values.map(([label, count], i) => (
        <span key={label}>
          {i > 0 && ' · '}
          <span className="font-semibold text-text-primary">{label}</span> ×{count}
        </span>
      ))}
      {tasks.unlabeled > 0 && (
        <>
          {values.length > 0 && ' · '}
          <span className="text-status-warning-text">
            {t('exportUnlabeled', { count: tasks.unlabeled })}
          </span>
        </>
      )}
    </p>
  );
}

/** Everything the preflight found, in the order it matters: how many come
 *  along, who does not and why, and what is missing from those that do. */
function PreflightPanel({ state }: { state: LeRobotExportState }) {
  const { t } = useTranslation('datasets');
  const preflight = state.preflight;
  if (state.preflightError) {
    return (
      <div data-testid="lerobot-export-preflight">
        <ErrorMessage error={state.preflightError} />
      </div>
    );
  }
  if (!preflight) {
    return (
      <p
        data-testid="lerobot-export-preflight"
        className="rounded-control border border-border bg-surface-muted px-3 py-2 text-[12px] text-text-muted"
      >
        {t('exportCheckingPreflight')}
      </p>
    );
  }
  const dropped = preflight.dropped;
  const reasons = [
    {
      key: 'not-on-this-machine',
      ids: dropped.not_local,
      text: t('exportDroppedNotLocal', { count: dropped.not_local.length }),
    },
    {
      key: 'excluded-in-review',
      ids: dropped.excluded,
      text: t('exportDroppedExcluded', { count: dropped.excluded.length }),
    },
    {
      key: 'still-recording',
      ids: dropped.recording,
      text: t('exportDroppedRecording', { count: dropped.recording.length }),
    },
  ];
  return (
    <div
      data-testid="lerobot-export-preflight"
      className="flex flex-col gap-1.5 rounded-control border border-border bg-surface-muted px-3 py-2"
    >
      <p
        data-testid="lerobot-export-included"
        className="text-[12.5px] text-text-primary"
      >
        <span className="font-semibold text-text-primary">
          {t('exportIncluded', {
            included: String(preflight.included),
            total: String(preflight.member_total),
          })}
        </span>
      </p>
      {reasons.map(({ key, ids, text }) =>
        ids.length === 0 ? null : (
          <p
            key={key}
            data-testid={`lerobot-export-dropped-${key}`}
            title={ids.map(shortCaptureId).join(', ')}
            className="text-[11.5px] text-text-secondary"
          >
            {text}
          </p>
        ),
      )}
      <TaskSummary state={state} />
      {preflight.missing_topics.length > 0 && (
        <div
          data-testid="lerobot-export-missing-topics"
          className="flex flex-col gap-0.5 rounded-control border border-status-danger-border bg-status-danger-bg px-2.5 py-1.5 text-[11.5px] leading-relaxed text-status-danger-text"
        >
          <span className="font-semibold">
            {t('exportMissingTopics', { count: preflight.missing_topics.length })}
          </span>
          {preflight.missing_topics.map((gap) => (
            <span key={gap.capture_id}>
              <span className="font-mono">{shortCaptureId(gap.capture_id)}</span>:
              {t('exportMissingTopic', { topics: gap.topics.join(', ') })}
            </span>
          ))}
          <span>{t('exportMissingTopicsHint')}</span>
        </div>
      )}
      {preflight.coverage_unknown.length > 0 && (
        <p
          data-testid="lerobot-export-coverage-unknown"
          className="text-[11.5px] leading-relaxed text-text-secondary"
        >
          {t('exportCoverageUnknown', { count: preflight.coverage_unknown.length })}
        </p>
      )}
    </div>
  );
}

/** Converting competes with a recording for this machine. Said, never used to
 *  block: the operator decides, and the recorder's own drop counters remain
 *  the authority on whether anything actually suffered. */
function RecordingCaution() {
  const { t } = useTranslation('datasets');
  const record = useRecordStatus();
  if (!record.anyLive) return null;
  return (
    <p
      data-testid="lerobot-export-recording-caution"
      className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
    >
      {t('exportRecordingCaution')}
    </p>
  );
}

function FormBody({
  state,
  datasetName,
}: {
  state: LeRobotExportState;
  datasetName: string;
}) {
  const { t } = useTranslation('datasets');
  const preflight = state.preflight;
  return (
    <div className="flex flex-col gap-3">
      <p className="break-words text-[13px] leading-relaxed text-text-secondary">
        {t('exportIntroduction', { dataset: datasetName })}
      </p>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t('profile')}</span>
        {/* Each control names ITSELF. The visible label wraps the field and
            its explanation both — the pattern the other dialogs here use — so
            without this the announced name is the whole paragraph, helper
            sentence and profile facts included. The text matches what is on
            screen (WCAG 2.5.3). */}
        <select
          data-testid="lerobot-export-profile"
          aria-label={t('profile')}
          value={state.profileName}
          onChange={(e) => state.setProfileName(e.target.value)}
          className={FIELD_INPUT}
        >
          {state.profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.name}
            </option>
          ))}
        </select>
        {state.profile && (
          <ProfileInfo
            profile={state.profile}
            validatorUnavailable={state.validatorUnavailable}
          />
        )}
        <span className="text-[11px] text-text-muted">{t('exportProfileHelp')}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>
          {t('memo')}{' '}
          <span className="font-normal normal-case text-text-muted">
            ({t('optional')})
          </span>
        </span>
        <input
          data-testid="lerobot-export-memo"
          aria-label={`${t('memo')} (${t('optional')})`}
          value={state.memo}
          onChange={(e) => state.setMemo(e.target.value)}
          spellCheck={false}
          maxLength={64}
          placeholder={t('exportMemoPlaceholder')}
          className={FIELD_INPUT}
        />
      </label>

      <div className="flex flex-col gap-1 rounded-control border border-border bg-surface-muted px-3 py-2">
        <span className={FIELD_LABEL}>{t('writesTo')}</span>
        <span
          data-testid="lerobot-export-output"
          className="break-all font-mono text-[12px] text-text-primary"
        >
          {preflight?.output ?? '—'}
        </span>
        {preflight?.output_exists && (
          <span
            data-testid="lerobot-export-output-exists"
            className="text-[11.5px] font-semibold leading-relaxed text-status-danger-text"
          >
            {t('exportOutputExists')}
          </span>
        )}
      </div>

      <PreflightPanel state={state} />

      {/* AFTER the preflight, not before it: this field exists only because
          the preflight found captures with no label of their own, and the
          panel that says so is what makes the field make sense. */}
      {state.taskRequired && (
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('fallbackTask')}</span>
          <input
            data-testid="lerobot-export-task"
            aria-label={t('fallbackTask')}
            value={state.taskFallback}
            onChange={(e) => state.setTaskFallback(e.target.value)}
            placeholder={t('exportTaskPlaceholder')}
            className={FIELD_INPUT}
          />
          <span className="text-[11px] leading-relaxed text-text-muted">
            {t('exportFallbackTask', {
              count: state.preflight?.tasks.unlabeled ?? 0,
            })}
          </span>
        </label>
      )}

      <RecordingCaution />

      {state.submitError != null && <ErrorMessage error={state.submitError} />}
    </div>
  );
}

function ProgressBody({ state }: { state: LeRobotExportState }) {
  const { t } = useTranslation('datasets');
  const status = state.status;
  if (!status) {
    return (
      <p
        data-testid="lerobot-export-progress"
        className="text-[12.5px] text-text-secondary"
      >
        {t('exportAcceptedWaiting')}
      </p>
    );
  }
  const queued = status.state === 'queued';
  const fraction = state.fraction;
  const pct = status.current_episode_pct;
  return (
    <div data-testid="lerobot-export-progress" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge tone={status.stalled ? 'amber' : 'teal'}>
          {exportStateLabel(t, status.state)}
        </Badge>
        <span
          data-testid="lerobot-export-progress-count"
          className="font-mono text-[13px] font-semibold text-text-primary"
        >
          {status.done} / {status.total}
        </span>
        <span className="text-[12px] text-text-muted">
          {t('exportEpisodesConverted')}
        </span>
      </div>

      {queued ? (
        <p
          data-testid="lerobot-export-queue"
          className="text-[12px] text-text-secondary"
        >
          {status.queue_position != null
            ? t('exportQueuePosition', { position: String(status.queue_position) })
            : t('exportQueueWaiting')}
        </p>
      ) : (
        <>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <div
              className={
                status.stalled ? 'h-full bg-status-warning-accent' : 'h-full bg-accent'
              }
              style={{
                width: fraction == null ? '0%' : `${Math.round(fraction * 100)}%`,
              }}
            />
          </div>
          <p className="text-[12px] text-text-muted">
            {fraction == null
              ? t('exportNoCount')
              : typeof pct === 'number' && pct > 0 && pct < 100
                ? t('exportCurrentEpisode', { percent: String(Math.round(pct)) })
                : t('exportWorking')}
          </p>
        </>
      )}

      {status.stalled && (
        <p
          data-testid="lerobot-export-stalled"
          className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
        >
          {t('exportStalled')}
        </p>
      )}
      {status.failed > 0 && (
        <p
          data-testid="lerobot-export-failed-count"
          className="text-[12px] text-status-danger-text"
        >
          {t('exportFailedSoFar', { count: status.failed })}
        </p>
      )}
      {status.message && (
        <p className="break-words text-[12px] leading-relaxed text-text-secondary">
          {status.message}
        </p>
      )}
      <p className="break-all font-mono text-[11px] text-text-muted">
        → {status.output}
      </p>
      {state.cancelError != null && <ErrorMessage error={state.cancelError} />}
    </div>
  );
}

/** The finished run, kept on screen until dismissed: what came of it and where
 *  it is. A failure keeps the exporter's own sentence rather than a summary of
 *  it — that sentence is the only account of what went wrong. */
function ResultBody({ state }: { state: LeRobotExportState }) {
  const { t } = useTranslation('datasets');
  const status = state.status;
  if (!status) return null;
  const complete = status.state === 'complete';
  return (
    <div data-testid="lerobot-export-result" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Badge tone={complete ? 'teal' : status.state === 'canceled' ? 'gray' : 'red'}>
          {exportStateLabel(t, status.state)}
        </Badge>
        <span className="font-mono text-[13px] font-semibold text-text-primary">
          {status.done} / {status.total}
        </span>
        <span className="text-[12px] text-text-muted">
          {t('exportEpisodesConverted')}
        </span>
      </div>
      {complete ? (
        <p className="text-[12.5px] leading-relaxed text-text-primary">
          {t('exportResultComplete', { count: status.done, output: '' })}{' '}
          <span
            data-testid="lerobot-export-result-output"
            className="break-all font-mono text-text-primary"
          >
            {status.output}
          </span>
          {status.failed > 0 && (
            <>
              {' '}
              <span className="text-status-danger-text">
                {t('exportResultPartialFailure', { count: status.failed })}
              </span>
            </>
          )}
        </p>
      ) : (
        <p
          data-testid="lerobot-export-result-message"
          className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12.5px] leading-relaxed text-status-warning-text"
        >
          {status.message ??
            (status.state === 'canceled'
              ? t('exportCanceled')
              : t('exportFailedNoReason'))}
        </p>
      )}
      {state.cancelError != null && <ErrorMessage error={state.cancelError} />}
    </div>
  );
}

export function LeRobotExportDialog({
  state,
  datasetName,
}: {
  state: LeRobotExportState;
  datasetName: string;
}) {
  const { t } = useTranslation(['datasets', 'common']);
  const running = state.live;
  const result = state.showResult;
  return (
    <Modal
      open={state.open}
      onClose={state.closeDialog}
      title={t('datasets:convertLeRobot')}
      footer={
        running ? (
          <>
            <Button
              variant="ghost"
              onClick={state.closeDialog}
              data-testid="lerobot-export-close"
            >
              {t('common:actions.close')}
            </Button>
            <Button
              variant="danger"
              onClick={state.cancel}
              disabled={state.canceling}
              title={t('datasets:cancelConversionHint')}
              data-testid="lerobot-export-abort"
            >
              {state.canceling
                ? t('datasets:canceling')
                : t('datasets:cancelConversion')}
            </Button>
          </>
        ) : result ? (
          <>
            <Button
              variant="ghost"
              onClick={state.acknowledge}
              data-testid="lerobot-export-again"
            >
              {t('datasets:convertAgain')}
            </Button>
            <Button
              variant="primary"
              onClick={state.closeDialog}
              data-testid="lerobot-export-close"
            >
              {t('common:actions.close')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={state.closeDialog}
              disabled={state.submitting}
              data-testid="lerobot-export-cancel"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={state.submit}
              disabled={state.blockedReason !== null || state.submitting}
              title={state.blockedReason ?? undefined}
              data-testid="lerobot-export-submit"
            >
              {state.submitting
                ? t('datasets:starting')
                : state.preflight
                  ? `${t('datasets:convert')} ${t('datasets:exportEpisode', { count: state.preflight.included })}`
                  : t('datasets:convert')}
            </Button>
          </>
        )
      }
    >
      {/* This is the tallest dialog on the screen — a full preflight report on
          top of four fields — and the shared Modal does not scroll, so on a
          720px-high laptop the form ran off both ends of the viewport with the
          destination preview and the blocked reason among the parts that were
          simply not reachable. Bounded here rather than in the Modal: every
          other dialog fits, and the footer buttons stay outside this box so
          Convert is always on screen. */}
      <div
        data-testid="lerobot-export-dialog"
        className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto"
      >
        {running ? (
          <ProgressBody state={state} />
        ) : result ? (
          <ResultBody state={state} />
        ) : (
          <FormBody state={state} datasetName={datasetName} />
        )}
      </div>
      {/* Outside the scroll box on purpose: this is the sentence that explains
          the disabled button next to it, and a reason the operator has to go
          looking for is a reason they will not read. */}
      {!running && !result && state.blockedReason && !state.preflightError && (
        <p
          data-testid="lerobot-export-blocked"
          className="mt-2 text-[12px] leading-relaxed text-text-secondary"
        >
          {state.blockedReason}
        </p>
      )}
    </Modal>
  );
}
