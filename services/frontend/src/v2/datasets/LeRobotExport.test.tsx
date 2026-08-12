// "Convert to LeRobot" (§6.2): the gate, the dialog's refusals, and the run.
//
// Driven through a harness that mounts the real hook with the real button and
// dialog, against a scripted fetch — the same shape as this screen's other
// tests. What is being pinned is the honesty contract rather than the layout:
//
//   * an installation without an exporter is offered NOTHING;
//   * every refusal the server would answer with is shown BEFORE the button
//     can be pressed, with the reason in words;
//   * a running conversion reports what the exporter actually said, including
//     "no progress for a while", and never invents a number it was not given.

import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { Dataset, ExportStatus } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { LeRobotExportButton } from './LeRobotExportButton';
import { LeRobotExportDialog } from './LeRobotExportDialog';
import {
  __resetExportPollMs,
  __resetMemoDebounceMs,
  __setExportPollMs,
  __setMemoDebounceMs,
  convertBlockedReason,
  exportFraction,
  useLeRobotExport,
} from './useLeRobotExport';

const DATASET: Dataset = {
  dataset_id: 'ds-1',
  name: 'kitchen_pick',
  operator: 'op_a',
  task: 'pick and place',
  status: 'active',
  created_at: '2026-08-13T08:00:00Z',
  member_count: 3,
};

const PROFILE = {
  name: 'default',
  path: '/config/myrobot/lerobot/default.yaml',
  source: 'committed',
  valid: true,
  errors: [] as string[],
  topics: ['/head_camera/image_raw', '/joint_states'],
  fps: 30,
};

interface Backend {
  /** `GET /exports/config` — the capability gate. */
  enabled: boolean;
  profiles: Record<string, unknown>[];
  /** The exporter is up but has no converter to validate its library with, so
   *  every profile's `valid` is null. `null` = an exporter that does not
   *  report the flag at all. */
  validatorUnavailable: boolean | null;
  preflight: Record<string, unknown>;
  /** Scripted `GET /datasets/{id}/export` answers, consumed in order; the last
   *  one repeats. Empty = 404, i.e. no export at all. */
  statuses: ExportStatus[];
  /** The run a successful `POST .../export` starts — which is the ONLY way a
   *  dialog reaches its progress face from the form, so the tests get there
   *  the way an operator does rather than by starting mid-run. */
  onSubmit: ExportStatus[];
  /** What `POST /datasets/{id}/export` answers with (202 unless set). */
  submitError: { status: number; code: string; message: string } | null;
  /** Non-empty `live_capture_ids` = a recording is in progress. */
  recordingLive: boolean;
  calls: string[];
}

function preflightBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataset_id: 'ds-1',
    profile: PROFILE,
    output_name: 'op_a_default',
    output: 'exports/op_a_default',
    output_exists: false,
    member_total: 3,
    included: 3,
    dropped: { not_local: [], excluded: [], recording: [] },
    tasks: { labeled: 3, unlabeled: 0, values: { 'pick and place': 3 } },
    missing_topics: [],
    coverage_unknown: [],
    ...over,
  };
}

function status(over: Partial<ExportStatus> = {}): ExportStatus {
  return {
    dataset_id: 'ds-1',
    export_id: 'ex-1',
    output: 'exports/op_a_default',
    state: 'running',
    done: 0,
    failed: 0,
    total: 3,
    ...over,
  };
}

function installBackend(over: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    enabled: true,
    profiles: [PROFILE],
    validatorUnavailable: false,
    preflight: preflightBody(),
    statuses: [],
    onSubmit: [],
    submitError: null,
    recordingLive: false,
    calls: [],
    ...over,
  };
  let statusReads = 0;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace(/^.*\/api\/v1/, '').split('?')[0]!;
    backend.calls.push(`${method} ${path}`);

    if (path === '/exports/config') {
      return jsonResponse({
        enabled: backend.enabled,
        profiles: backend.profiles,
        validator_unavailable: backend.validatorUnavailable,
      });
    }
    if (path === '/record/status') {
      return jsonResponse({
        run_id: null,
        state: backend.recordingLive ? 'recording' : 'completed',
        live_capture_ids: backend.recordingLive ? ['cap-live'] : [],
      });
    }
    if (path.endsWith('/export/preflight')) {
      // The memo is part of the output name, so the answer follows it — this
      // is what the destination preview and its "already exists" line read.
      const memo = new URL(url, 'http://x').searchParams.get('memo') ?? '';
      const base = backend.preflight;
      if (!memo) return jsonResponse(base);
      const name = `${String(base.output_name)}_${memo}`;
      return jsonResponse({ ...base, output_name: name, output: `exports/${name}` });
    }
    if (path.endsWith('/export/cancel')) {
      const canceled = status({ state: 'canceled', message: 'Cancelled by the operator.' });
      backend.statuses = [canceled];
      return jsonResponse(canceled);
    }
    if (path.endsWith('/export') && method === 'POST') {
      if (backend.submitError) {
        return jsonResponse(
          {
            error: {
              code: backend.submitError.code,
              message: backend.submitError.message,
              details: {},
            },
          },
          backend.submitError.status,
        );
      }
      backend.statuses = backend.onSubmit;
      statusReads = 0;
      return jsonResponse(
        {
          export_id: 'ex-1',
          dataset_id: 'ds-1',
          output: 'exports/op_a_default',
          included: 3,
          dropped: { not_local: [], excluded: [], recording: [] },
        },
        202,
      );
    }
    if (path.endsWith('/export')) {
      if (backend.statuses.length === 0) {
        return jsonResponse(
          { error: { code: 'export_not_found', message: 'none here' } },
          404,
        );
      }
      const next =
        backend.statuses[Math.min(statusReads, backend.statuses.length - 1)]!;
      statusReads += 1;
      return jsonResponse(next);
    }
    return jsonResponse({});
  });
  return backend;
}

/** The button and the dialog, wired by the real hook — the three pieces that
 *  ship together. The toast is rendered so the completion edge is observable. */
function Harness({ dataset = DATASET }: { dataset?: Dataset | null }) {
  const [toast, setToast] = useState('');
  const state = useLeRobotExport({ dataset, onToast: setToast });
  return (
    <>
      <LeRobotExportButton state={state} />
      <LeRobotExportDialog state={state} datasetName={dataset?.name ?? '—'} />
      <span data-testid="harness-toast">{toast}</span>
    </>
  );
}

async function openDialog(): Promise<void> {
  fireEvent.click(await screen.findByTestId('convert-lerobot-btn'));
  await screen.findByTestId('lerobot-export-dialog');
}

beforeEach(() => {
  setApiBase('/api/v1');
  __setMemoDebounceMs(1);
  __setExportPollMs(5);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetMemoDebounceMs();
  __resetExportPollMs();
});

// ---- the gate --------------------------------------------------------------

describe('the capability gate', () => {
  test('no exporter on this installation renders no control at all', async () => {
    installBackend({ enabled: false, profiles: [] });
    renderWithClient(<Harness />);
    // Waited on rather than asserted immediately: absence before the config
    // has even been read would prove nothing.
    await waitFor(() => expect(screen.getByTestId('harness-toast')).toBeTruthy());
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('convert-lerobot-btn')).toBeNull();
  });

  test('an exporter with an empty library is also no control', async () => {
    installBackend({ enabled: true, profiles: [] });
    renderWithClient(<Harness />);
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('convert-lerobot-btn')).toBeNull();
  });

  test('a dataset with no members is not offered the conversion', async () => {
    installBackend();
    renderWithClient(<Harness dataset={{ ...DATASET, member_count: 0 }} />);
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('convert-lerobot-btn')).toBeNull();
  });

  test('an exporter with profiles and a populated dataset gets the button', async () => {
    installBackend();
    renderWithClient(<Harness />);
    const button = await screen.findByTestId('convert-lerobot-btn');
    expect(button.textContent).toContain('Convert to LeRobot');
  });
});

// ---- the form face ---------------------------------------------------------

describe('the dialog before it is committed to', () => {
  test('shows what would be converted, where it lands, and the profile facts', async () => {
    installBackend();
    renderWithClient(<Harness />);
    await openDialog();

    expect((await screen.findByTestId('lerobot-export-profile')) as HTMLSelectElement)
      .toHaveProperty('value', 'default');
    expect(screen.getByTestId('lerobot-export-profile-info').textContent).toContain('valid');
    expect(screen.getByTestId('lerobot-export-profile-info').textContent).toContain('30 fps');
    await waitFor(() =>
      expect(screen.getByTestId('lerobot-export-output').textContent).toBe(
        'exports/op_a_default',
      ),
    );
    expect(screen.getByTestId('lerobot-export-included').textContent).toContain('3 of 3');
    await waitFor(() =>
      expect(screen.getByTestId('lerobot-export-submit').textContent).toContain(
        'Convert 3 episodes',
      ),
    );
    expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test('the destination follows the memo, and an occupied one refuses', async () => {
    const backend = installBackend();
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect(screen.getByTestId('lerobot-export-output').textContent).toBe(
        'exports/op_a_default',
      ),
    );

    backend.preflight = preflightBody({ output_exists: true });
    fireEvent.change(screen.getByTestId('lerobot-export-memo'), {
      target: { value: 'rerun2' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('lerobot-export-output').textContent).toBe(
        'exports/op_a_default_rerun2',
      ),
    );
    await screen.findByTestId('lerobot-export-output-exists');
    expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId('lerobot-export-blocked').textContent).toContain(
      'already exists',
    );
  });

  test('a profile the converter rejects shows its errors and cannot be run', async () => {
    installBackend({
      profiles: [
        {
          ...PROFILE,
          valid: false,
          errors: ['observations[1].topic: /gripper not found in the bag'],
        },
      ],
    });
    renderWithClient(<Harness />);
    await openDialog();
    expect((await screen.findByTestId('lerobot-export-profile-errors')).textContent).toContain(
      '/gripper not found',
    );
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByTestId('lerobot-export-blocked').textContent).toContain(
      'does not validate',
    );
  });

  test('an unverified profile says WHY when the exporter has no converter', async () => {
    installBackend({
      profiles: [{ ...PROFILE, valid: null, errors: [] }],
      validatorUnavailable: true,
    });
    renderWithClient(<Harness />);
    await openDialog();
    const info = await screen.findByTestId('lerobot-export-profile-info');
    expect(info.textContent).toContain('not verified');
    expect(info.textContent).toContain('no converter installed');
    // Unverified is not a refusal: the conversion may still work, and only
    // `valid: false` is the converter actually refusing the file.
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  test('an exporter that never reports the flag claims no reason for it', async () => {
    // `validator_unavailable: null` is "we were not told", which must not be
    // rendered as "the validator is missing".
    installBackend({
      profiles: [{ ...PROFILE, valid: null, errors: [] }],
      validatorUnavailable: null,
    });
    renderWithClient(<Harness />);
    await openDialog();
    const info = await screen.findByTestId('lerobot-export-profile-info');
    expect(info.textContent).toContain('not verified');
    expect(info.textContent).not.toContain('no converter installed');
  });

  test('unlabeled captures demand a fallback task, prefilled from the dataset', async () => {
    installBackend({
      preflight: preflightBody({
        tasks: { labeled: 2, unlabeled: 1, values: { 'pick and place': 2 } },
      }),
    });
    renderWithClient(<Harness />);
    await openDialog();

    const field = (await screen.findByTestId('lerobot-export-task')) as HTMLInputElement;
    expect(field.value).toBe('pick and place');
    expect(screen.getByTestId('lerobot-export-tasks').textContent).toContain('1 unlabeled');

    fireEvent.change(field, { target: { value: '  ' } });
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByTestId('lerobot-export-blocked').textContent).toContain(
      'needs a fallback task',
    );
  });

  test('with every capture labelled there is no fallback field to fill in', async () => {
    installBackend();
    renderWithClient(<Harness />);
    await openDialog();
    await screen.findByTestId('lerobot-export-included');
    expect(screen.queryByTestId('lerobot-export-task')).toBeNull();
  });

  test('names the dropped members, the missing topics and the unreadable manifests', async () => {
    installBackend({
      preflight: preflightBody({
        included: 1,
        member_total: 4,
        dropped: {
          not_local: ['cap-away'],
          excluded: ['cap-bad'],
          recording: ['cap-live'],
        },
        missing_topics: [{ capture_id: 'cap-a', topics: ['/joint_states'] }],
        coverage_unknown: ['cap-c'],
      }),
    });
    renderWithClient(<Harness />);
    await openDialog();

    expect((await screen.findByTestId('lerobot-export-included')).textContent).toContain(
      '1 of 4',
    );
    expect(screen.getByTestId('lerobot-export-dropped-not-on-this-machine')).toBeTruthy();
    expect(screen.getByTestId('lerobot-export-dropped-excluded-in-review')).toBeTruthy();
    expect(screen.getByTestId('lerobot-export-dropped-still-recording')).toBeTruthy();
    expect(screen.getByTestId('lerobot-export-missing-topics').textContent).toContain(
      '/joint_states',
    );
    expect(screen.getByTestId('lerobot-export-coverage-unknown').textContent).toContain(
      'unknown',
    );
  });

  test('nothing convertible disables the button and says why', async () => {
    installBackend({
      preflight: preflightBody({
        included: 0,
        dropped: { not_local: ['a', 'b', 'c'], excluded: [], recording: [] },
        tasks: { labeled: 0, unlabeled: 0, values: {} },
      }),
    });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByTestId('lerobot-export-blocked').textContent).toContain(
      'Nothing here can be converted',
    );
  });

  test('a live recording is mentioned, not used to block', async () => {
    installBackend({ recordingLive: true });
    renderWithClient(<Harness />);
    await openDialog();
    expect((await screen.findByTestId('lerobot-export-recording-caution')).textContent).toContain(
      'share CPU',
    );
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  test('every control names itself, and by what is on screen', async () => {
    // The visible labels wrap both the field and its explanation, so without
    // the explicit names a screen reader announces the whole paragraph.
    installBackend({
      preflight: preflightBody({
        tasks: { labeled: 2, unlabeled: 1, values: { 'pick and place': 2 } },
      }),
    });
    renderWithClient(<Harness />);
    await openDialog();
    expect(screen.getByRole('combobox', { name: 'Profile' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Memo (optional)' })).toBeTruthy();
    expect(await screen.findByRole('textbox', { name: 'Fallback task' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Convert \d+ episodes?/ })).toBeTruthy(),
    );
  });

  test('Escape closes the dialog', async () => {
    installBackend();
    renderWithClient(<Harness />);
    await openDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('lerobot-export-dialog')).toBeNull());
  });

  test("a refusal from the server is shown in the server's own words", async () => {
    installBackend({
      submitError: {
        status: 409,
        code: 'export_in_progress',
        message: 'Dataset ds-1 already has an export (exports/op_a_default) queued or running.',
      },
    });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('lerobot-export-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already has an export');
    expect(alert.getAttribute('data-error-code')).toBe('export_in_progress');
  });
});

// ---- the run ---------------------------------------------------------------

describe('a conversion that is running', () => {
  test('queued reports its place in the queue', async () => {
    installBackend({
      onSubmit: [status({ state: 'queued', queue_position: 2, total: 0 })],
    });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('lerobot-export-submit'));

    expect((await screen.findByTestId('lerobot-export-queue')).textContent).toContain(
      'number 2',
    );
  });

  test('progress composes finished episodes with the current one', async () => {
    installBackend({
      onSubmit: [status({ done: 1, total: 4, current_episode_pct: 50 })],
    });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('lerobot-export-submit'));

    expect((await screen.findByTestId('lerobot-export-progress-count')).textContent).toBe(
      '1 / 4',
    );
    expect(screen.getByTestId('lerobot-export-progress').textContent).toContain(
      'Current episode 50%',
    );
    // (1 + 0.5) / 4 = 37.5% -> 38% of the bar.
    expect(exportFraction(status({ done: 1, total: 4, current_episode_pct: 50 }))).toBeCloseTo(
      0.375,
    );
  });

  test('a stall is reported as an observation, and cancels nothing', async () => {
    installBackend({ onSubmit: [status({ done: 2, total: 4, stalled: true })] });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('lerobot-export-submit'));

    expect((await screen.findByTestId('lerobot-export-stalled')).textContent).toContain(
      'No progress has been reported',
    );
    expect(screen.getByTestId('lerobot-export-abort')).toBeTruthy();
  });

  test('completion shows the output path and toasts it', async () => {
    installBackend({
      onSubmit: [
        status({ done: 1, total: 3 }),
        status({ state: 'complete', done: 3, total: 3 }),
      ],
    });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('lerobot-export-submit'));

    const output = await screen.findByTestId('lerobot-export-result-output');
    expect(output.textContent).toBe('exports/op_a_default');
    await waitFor(() =>
      expect(screen.getByTestId('harness-toast').textContent).toContain(
        'Converted 3 episodes to exports/op_a_default',
      ),
    );
    // The outcome stays until dismissed; dismissing returns the form.
    fireEvent.click(screen.getByTestId('lerobot-export-again'));
    await screen.findByTestId('lerobot-export-submit');
  });

  test('cancelling reports the cancelled state rather than a success', async () => {
    installBackend({ onSubmit: [status({ done: 1, total: 3 })] });
    renderWithClient(<Harness />);
    await openDialog();
    await waitFor(() =>
      expect((screen.getByTestId('lerobot-export-submit') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('lerobot-export-submit'));

    fireEvent.click(await screen.findByTestId('lerobot-export-abort'));
    const message = await screen.findByTestId('lerobot-export-result-message');
    expect(message.textContent).toContain('Cancelled');
    expect(screen.getByTestId('harness-toast').textContent).toBe('');
  });

  test('an export already running when the screen loads is not announced as new', async () => {
    // Terminal on the first read, never seen live by this session: history, so
    // no result panel and no toast — but the form is still usable.
    installBackend({ statuses: [status({ state: 'complete', done: 3, total: 3 })] });
    renderWithClient(<Harness />);
    await openDialog();
    await screen.findByTestId('lerobot-export-included');
    expect(screen.queryByTestId('lerobot-export-result')).toBeNull();
    expect(screen.getByTestId('harness-toast').textContent).toBe('');
  });
});

// ---- the pure rules --------------------------------------------------------

describe('the rules on their own', () => {
  test('no total means no fraction to claim', () => {
    expect(exportFraction(null)).toBeNull();
    expect(exportFraction(status({ total: 0 }))).toBeNull();
  });

  test('the fraction never exceeds a whole', () => {
    expect(exportFraction(status({ done: 4, total: 4, current_episode_pct: 90 }))).toBe(1);
  });

  test('a missing profile blocks before anything else is considered', () => {
    expect(
      convertBlockedReason({
        profile: null,
        preflight: null,
        preflightLoading: false,
        preflightFailed: false,
        taskFallback: '',
      }),
    ).toContain('Pick a profile');
  });

  test('an unreadable preflight blocks: what would happen is unknown', () => {
    expect(
      convertBlockedReason({
        profile: PROFILE,
        preflight: null,
        preflightLoading: false,
        preflightFailed: true,
        taskFallback: '',
      }),
    ).toContain('unknown');
  });
});
