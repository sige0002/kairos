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
import { useRecordStatus } from '../captures/useRecordStatus';
import { shortCaptureId } from './data';
import type { ExportProfile } from '../../api/types';
import type { LeRobotExportState } from './useLeRobotExport';

const FIELD_LABEL =
  'text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500';
const FIELD_INPUT =
  'rounded-control border border-gray-200 bg-white px-2 py-1.5 text-[12.5px] text-gray-700';

function episodes(n: number): string {
  return `${n} episode${n === 1 ? '' : 's'}`;
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
  const facts: string[] = [];
  if (profile.fps != null) facts.push(`${profile.fps} fps`);
  if (profile.topics?.length) facts.push(`${profile.topics.length} topics`);
  if (profile.source) facts.push(profile.source);
  return (
    <>
      <span data-testid="lerobot-export-profile-info" className="text-[11px] text-gray-500">
        {profile.valid === true && <span className="text-teal-700">✓ valid</span>}
        {profile.valid == null && (
          <span className="text-amber-700">
            {validatorUnavailable
              ? 'not verified — the exporter has no converter installed to check with'
              : 'not verified — nothing has checked this profile'}
          </span>
        )}
        {profile.valid === false && (
          <span className="text-red-700 font-semibold">does not validate</span>
        )}
        {facts.length > 0 && <> · {facts.join(' · ')}</>}
      </span>
      {profile.valid === false && (
        <ul
          data-testid="lerobot-export-profile-errors"
          className="flex flex-col gap-0.5 rounded-control border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-red-800"
        >
          {(profile.errors ?? ['The converter gave no reason.']).map((error) => (
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
  const tasks = state.preflight?.tasks;
  if (!tasks) return null;
  const values = Object.entries(tasks.values);
  if (values.length <= 1 && tasks.unlabeled === 0) return null;
  return (
    <p data-testid="lerobot-export-tasks" className="text-[11.5px] text-gray-600">
      Task labels:{' '}
      {values.map(([label, count], i) => (
        <span key={label}>
          {i > 0 && ' · '}
          <span className="font-semibold text-gray-800">{label}</span> ×{count}
        </span>
      ))}
      {tasks.unlabeled > 0 && (
        <>
          {values.length > 0 && ' · '}
          <span className="text-amber-700">{tasks.unlabeled} unlabeled</span>
        </>
      )}
    </p>
  );
}

/** Everything the preflight found, in the order it matters: how many come
 *  along, who does not and why, and what is missing from those that do. */
function PreflightPanel({ state }: { state: LeRobotExportState }) {
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
        className="rounded-control border border-gray-100 bg-gray-50 px-3 py-2 text-[12px] text-gray-500"
      >
        Checking what this profile would convert…
      </p>
    );
  }
  const dropped = preflight.dropped;
  const reasons: Array<[string, string[]]> = [
    ['not on this machine', dropped.not_local],
    ['excluded in review', dropped.excluded],
    ['still recording', dropped.recording],
  ];
  return (
    <div
      data-testid="lerobot-export-preflight"
      className="flex flex-col gap-1.5 rounded-control border border-gray-100 bg-gray-50 px-3 py-2"
    >
      <p data-testid="lerobot-export-included" className="text-[12.5px] text-gray-700">
        <span className="font-semibold text-gray-900">
          {preflight.included} of {preflight.member_total}
        </span>{' '}
        member{preflight.member_total === 1 ? '' : 's'} would be converted.
      </p>
      {reasons.map(([why, ids]) =>
        ids.length === 0 ? null : (
          <p
            key={why}
            data-testid={`lerobot-export-dropped-${why.replace(/\s+/g, '-')}`}
            title={ids.map(shortCaptureId).join(', ')}
            className="text-[11.5px] text-gray-600"
          >
            {ids.length} left out — {why}.
          </p>
        ),
      )}
      <TaskSummary state={state} />
      {preflight.missing_topics.length > 0 && (
        <div
          data-testid="lerobot-export-missing-topics"
          className="flex flex-col gap-0.5 rounded-control border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-red-800"
        >
          <span className="font-semibold">
            {preflight.missing_topics.length === 1
              ? '1 recording does not contain'
              : `${preflight.missing_topics.length} recordings do not contain`}{' '}
            every topic this profile reads:
          </span>
          {preflight.missing_topics.map((gap) => (
            <span key={gap.capture_id}>
              <span className="font-mono">{shortCaptureId(gap.capture_id)}</span>:
              missing {gap.topics.join(', ')}
            </span>
          ))}
          <span>
            The conversion is not blocked, but those episodes are what would
            fail first.
          </span>
        </div>
      )}
      {preflight.coverage_unknown.length > 0 && (
        <p
          data-testid="lerobot-export-coverage-unknown"
          className="text-[11.5px] leading-relaxed text-gray-600"
        >
          {preflight.coverage_unknown.length} recording
          {preflight.coverage_unknown.length === 1 ? "'s" : "s'"} manifest could
          not be read, so whether they hold the profile's topics is unknown —
          not checked, rather than checked and fine.
        </p>
      )}
    </div>
  );
}

/** Converting competes with a recording for this machine. Said, never used to
 *  block: the operator decides, and the recorder's own drop counters remain
 *  the authority on whether anything actually suffered. */
function RecordingCaution() {
  const record = useRecordStatus();
  if (!record.anyLive) return null;
  return (
    <p
      data-testid="lerobot-export-recording-caution"
      className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
    >
      A recording is live right now. Converting reads and re-encodes on this
      same machine, so the two share CPU and disk — it is allowed, but a take
      you care about is worth finishing first.
    </p>
  );
}

function FormBody({ state, datasetName }: { state: LeRobotExportState; datasetName: string }) {
  const preflight = state.preflight;
  return (
    <div className="flex flex-col gap-3">
      <p className="break-words text-[13px] leading-relaxed text-gray-600">
        <span className="font-semibold text-gray-900">{datasetName}</span> is
        converted to a LeRobot v3 dataset written under{' '}
        <span className="font-mono text-gray-700">exports/</span>.{' '}
        <span className="font-semibold text-gray-800">
          Nothing here changes:
        </span>{' '}
        the recordings are read where they are, and the dataset keeps its
        members and its labels.
      </p>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>Profile</span>
        {/* Each control names ITSELF. The visible label wraps the field and
            its explanation both — the pattern the other dialogs here use — so
            without this the announced name is the whole paragraph, helper
            sentence and profile facts included. The text matches what is on
            screen (WCAG 2.5.3). */}
        <select
          data-testid="lerobot-export-profile"
          aria-label="Profile"
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
        <span className="text-[11px] text-gray-500">
          fps, camera set and resampling belong to the profile — to change one,
          pick another profile.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>
          Memo <span className="font-normal normal-case text-gray-500">(optional)</span>
        </span>
        <input
          data-testid="lerobot-export-memo"
          aria-label="Memo (optional)"
          value={state.memo}
          onChange={(e) => state.setMemo(e.target.value)}
          spellCheck={false}
          maxLength={64}
          placeholder="e.g. rerun2"
          className={FIELD_INPUT}
        />
      </label>

      <div className="flex flex-col gap-1 rounded-control border border-gray-100 bg-gray-50 px-3 py-2">
        <span className={FIELD_LABEL}>Writes to</span>
        <span
          data-testid="lerobot-export-output"
          className="break-all font-mono text-[12px] text-gray-800"
        >
          {preflight?.output ?? '—'}
        </span>
        {preflight?.output_exists && (
          <span
            data-testid="lerobot-export-output-exists"
            className="text-[11.5px] font-semibold leading-relaxed text-red-700"
          >
            That folder already exists and is not empty — change the memo, or
            delete the old export first. Nothing is overwritten.
          </span>
        )}
      </div>

      <PreflightPanel state={state} />

      {/* AFTER the preflight, not before it: this field exists only because
          the preflight found captures with no label of their own, and the
          panel that says so is what makes the field make sense. */}
      {state.taskRequired && (
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Fallback task</span>
          <input
            data-testid="lerobot-export-task"
            aria-label="Fallback task"
            value={state.taskFallback}
            onChange={(e) => state.setTaskFallback(e.target.value)}
            placeholder="e.g. pick and place the red block"
            className={FIELD_INPUT}
          />
          <span className="text-[11px] leading-relaxed text-gray-500">
            {(state.preflight?.tasks.unlabeled ?? 0) === 1
              ? 'Used only for the one recording that carries no task label of its own'
              : `Used only for the ${state.preflight?.tasks.unlabeled ?? 0} recordings that carry no task label of their own`}
            ; every labelled one keeps the label it has.
          </span>
        </label>
      )}

      <RecordingCaution />

      {state.submitError != null && <ErrorMessage error={state.submitError} />}
    </div>
  );
}

function ProgressBody({ state }: { state: LeRobotExportState }) {
  const status = state.status;
  if (!status) {
    return (
      <p data-testid="lerobot-export-progress" className="text-[12.5px] text-gray-600">
        The conversion was accepted. Waiting for the exporter's first report…
      </p>
    );
  }
  const queued = status.state === 'queued';
  const fraction = state.fraction;
  const pct = status.current_episode_pct;
  return (
    <div data-testid="lerobot-export-progress" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge tone={status.stalled ? 'amber' : 'teal'}>{status.state}</Badge>
        <span
          data-testid="lerobot-export-progress-count"
          className="font-mono text-[13px] font-semibold text-gray-900"
        >
          {status.done} / {status.total}
        </span>
        <span className="text-[12px] text-gray-500">episodes converted</span>
      </div>

      {queued ? (
        <p data-testid="lerobot-export-queue" className="text-[12px] text-gray-600">
          {status.queue_position != null
            ? `Waiting its turn — number ${status.queue_position} in the exporter's queue.`
            : 'Waiting its turn in the exporter’s queue.'}
        </p>
      ) : (
        <>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className={status.stalled ? 'h-full bg-amber-400' : 'h-full bg-teal-500'}
              style={{ width: fraction == null ? '0%' : `${Math.round(fraction * 100)}%` }}
            />
          </div>
          <p className="text-[12px] text-gray-500">
            {fraction == null
              ? 'The exporter has not reported an episode count yet, so there is no share of the whole to show.'
              : typeof pct === 'number' && pct > 0 && pct < 100
                ? `Current episode ${Math.round(pct)}%.`
                : 'Working through the episodes.'}
          </p>
        </>
      )}

      {status.stalled && (
        <p
          data-testid="lerobot-export-stalled"
          className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
        >
          No progress has been reported for a while — the converter may be stuck
          on this episode. Nothing has been cancelled; this is what the exporter
          observes, not a verdict.
        </p>
      )}
      {status.failed > 0 && (
        <p data-testid="lerobot-export-failed-count" className="text-[12px] text-red-700">
          {episodes(status.failed)} failed to convert so far.
        </p>
      )}
      {status.message && (
        <p className="break-words text-[12px] leading-relaxed text-gray-600">
          {status.message}
        </p>
      )}
      <p className="break-all font-mono text-[11px] text-gray-500">→ {status.output}</p>
      {state.cancelError != null && <ErrorMessage error={state.cancelError} />}
    </div>
  );
}

/** The finished run, kept on screen until dismissed: what came of it and where
 *  it is. A failure keeps the exporter's own sentence rather than a summary of
 *  it — that sentence is the only account of what went wrong. */
function ResultBody({ state }: { state: LeRobotExportState }) {
  const status = state.status;
  if (!status) return null;
  const complete = status.state === 'complete';
  return (
    <div data-testid="lerobot-export-result" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Badge tone={complete ? 'teal' : status.state === 'canceled' ? 'gray' : 'red'}>
          {status.state}
        </Badge>
        <span className="font-mono text-[13px] font-semibold text-gray-900">
          {status.done} / {status.total}
        </span>
        <span className="text-[12px] text-gray-500">episodes converted</span>
      </div>
      {complete ? (
        <p className="text-[12.5px] leading-relaxed text-gray-700">
          {episodes(status.done)} written to{' '}
          <span
            data-testid="lerobot-export-result-output"
            className="break-all font-mono text-gray-900"
          >
            {status.output}
          </span>
          {status.failed > 0 && (
            <>
              {' '}
              <span className="text-red-700">
                ({episodes(status.failed)} failed — the converter's log has the
                reason.)
              </span>
            </>
          )}
        </p>
      ) : (
        <p
          data-testid="lerobot-export-result-message"
          className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900"
        >
          {status.message ??
            (status.state === 'canceled'
              ? 'Cancelled. The partial output was removed, so there is nothing half-converted left behind.'
              : 'The conversion failed and the exporter gave no reason.')}
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
  const running = state.live;
  const result = state.showResult;
  return (
    <Modal
      open={state.open}
      onClose={state.closeDialog}
      title="Convert to LeRobot"
      footer={
        running ? (
          <>
            <Button
              variant="ghost"
              onClick={state.closeDialog}
              data-testid="lerobot-export-close"
            >
              Close
            </Button>
            <Button
              variant="danger"
              onClick={state.cancel}
              disabled={state.canceling}
              title="Stop the conversion. The partial output is removed — a cancelled conversion leaves nothing to resume from, so it starts over."
              data-testid="lerobot-export-abort"
            >
              {state.canceling ? 'Cancelling…' : 'Cancel conversion'}
            </Button>
          </>
        ) : result ? (
          <>
            <Button
              variant="ghost"
              onClick={state.acknowledge}
              data-testid="lerobot-export-again"
            >
              Convert again…
            </Button>
            <Button
              variant="primary"
              onClick={state.closeDialog}
              data-testid="lerobot-export-close"
            >
              Close
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
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={state.submit}
              disabled={state.blockedReason !== null || state.submitting}
              title={state.blockedReason ?? undefined}
              data-testid="lerobot-export-submit"
            >
              {state.submitting
                ? 'Starting…'
                : state.preflight
                  ? `Convert ${episodes(state.preflight.included)}`
                  : 'Convert'}
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
          className="mt-2 text-[12px] leading-relaxed text-gray-600"
        >
          {state.blockedReason}
        </p>
      )}
    </Modal>
  );
}
