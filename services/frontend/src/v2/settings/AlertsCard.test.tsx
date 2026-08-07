import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { AlertsCard } from './AlertsCard';

const ALERTS = {
  path: '/config/airoa_hsr/monitoring/alerts.yaml',
  raw: 'rules:\n  - topic: /hsrb/joint_states\n    metric: hz\n    op: lt\n    threshold: 15\n',
  warnings: [],
  config: {
    rules: [
      { topic: '/hsrb/joint_states', metric: 'hz', op: 'lt', threshold: 15, clear_after_s: 3, cooldown_s: 10 },
    ],
    derived_rules: { enabled: true, warn_ratio: 0.8 },
  },
};

// What GET /config/alerts currently serves. Tests that simulate another
// terminal saving the file reassign this between renders.
let serverAlerts: typeof ALERTS = ALERTS;

type PutHandler = (body: unknown) => Response;
const okPut: PutHandler = () => jsonResponse({ ...ALERTS });

// alerts.yaml is the ACTIVE robot's file, so AlertsCard resolves the robot
// first (GET /config/options) and keys its cache on it — see alertsConfigKey.
const OPTIONS = { active_robot: 'airoa_hsr', robots: [{ id: 'airoa_hsr', local: false }], aspects: {} };

function mockFetch(put: PutHandler = okPut) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse(OPTIONS));
    }
    if (url.includes('/config/alerts')) {
      if (init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        return Promise.resolve(put(body));
      }
      return Promise.resolve(jsonResponse(serverAlerts));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  serverAlerts = ALERTS;
});
afterEach(() => vi.restoreAllMocks());

test('renders the rules table seeded from the alerts aspect + honest badge', async () => {
  mockFetch();
  renderWithClient(<AlertsCard />);

  const topic = (await screen.findByLabelText('rule topic 0')) as HTMLInputElement;
  expect(topic.value).toBe('/hsrb/joint_states');
  expect((screen.getByLabelText('rule metric 0') as HTMLSelectElement).value).toBe('hz');
  expect((screen.getByLabelText('rule op 0') as HTMLSelectElement).value).toBe('lt');
  expect((screen.getByLabelText('rule threshold 0') as HTMLInputElement).value).toBe('15');
  // derived_rules block is shown read-only, and the badge is honest about timing.
  expect(screen.getByTestId('alerts-derived')).toHaveTextContent('warn_ratio');
  expect(screen.getByText('applies on monitor restart')).toBeInTheDocument();
});

test('selecting metric "loss" warns inline that it can never fire', async () => {
  mockFetch();
  renderWithClient(<AlertsCard />);
  const metric = (await screen.findByLabelText('rule metric 0')) as HTMLSelectElement;
  expect(screen.queryByTestId('alerts-loss-warn-0')).not.toBeInTheDocument();

  fireEvent.change(metric, { target: { value: 'loss' } });
  expect(screen.getByTestId('alerts-loss-warn-0')).toHaveTextContent('can never fire');
});

test('Save posts the edited rules and shows the saved banner', async () => {
  const put = vi.fn(okPut);
  mockFetch(put);
  renderWithClient(<AlertsCard />);

  const threshold = (await screen.findByLabelText('rule threshold 0')) as HTMLInputElement;
  fireEvent.change(threshold, { target: { value: '20' } });
  fireEvent.click(screen.getByTestId('alerts-save'));

  await screen.findByTestId('alerts-saved');
  expect(put).toHaveBeenCalledTimes(1);
  const body = put.mock.calls[0]![0] as { config: { rules: { threshold: number }[] } };
  expect(body.config.rules[0]!.threshold).toBe(20);
  // derived_rules is preserved across a form save (edited only via Advanced).
  const withDerived = put.mock.calls[0]![0] as { config: { derived_rules?: unknown } };
  expect(withDerived.config.derived_rules).toEqual({ enabled: true, warn_ratio: 0.8 });
});

test('a server loss warning is surfaced after save', async () => {
  const lossPut: PutHandler = () =>
    jsonResponse({
      ...ALERTS,
      warnings: ["Rule for /x: metric 'loss' can never fire (loss_rate is null in the monitor); use hz or gap instead."],
    });
  mockFetch(lossPut);
  renderWithClient(<AlertsCard />);

  fireEvent.click(await screen.findByTestId('alerts-save'));
  const warns = await screen.findByTestId('alerts-warnings');
  expect(warns).toHaveTextContent('can never fire');
});

test('a 422 surfaces the pydantic field errors inline', async () => {
  const badPut: PutHandler = () =>
    jsonResponse(
      {
        error: {
          code: 'invalid_config',
          message: 'Alerts config failed validation.',
          details: { errors: [{ loc: ['rules', 0, 'metric'], msg: 'Input should be hz, bandwidth, ...' }] },
        },
      },
      422,
    );
  mockFetch(badPut);
  renderWithClient(<AlertsCard />);

  fireEvent.click(await screen.findByTestId('alerts-save'));
  const errors = await screen.findByTestId('alerts-errors');
  expect(errors).toHaveTextContent('rules.0.metric');
});

test('Add rule appends an editable row', async () => {
  mockFetch();
  renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');
  fireEvent.click(screen.getByTestId('alerts-add-rule'));
  await waitFor(() => expect(screen.getByLabelText('rule topic 1')).toBeInTheDocument());
});

// ---------------------------------------------------------------------------
// Two editors, one file (2026-08-04 regression): raw-YAML edits + the main
// Save used to silently write the stale table state while the screen kept
// showing the never-sent YAML as if it were saved.
// ---------------------------------------------------------------------------

test('unsaved raw-YAML edits block the form Save and say why', async () => {
  const fetchSpy = mockFetch();
  renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  fireEvent.change(screen.getByLabelText('alerts config yaml'), {
    target: { value: ALERTS.raw + '  - topic: /edited\n    metric: gap\n    op: gt\n    threshold: 2\n' },
  });

  // The main Save is disabled with the reason inline; the dirty chip shows.
  expect(screen.getByTestId('alerts-save')).toBeDisabled();
  expect(screen.getByTestId('alerts-form-save-blocked')).toHaveTextContent('Save YAML');
  expect(screen.getByTestId('alerts-raw-dirty')).toHaveTextContent('unsaved');
  // Nothing was PUT — the stale table state cannot overwrite the file.
  expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});

test('Save YAML sends the raw text and re-seeds both editors from the response', async () => {
  const serverPayload = {
    ...ALERTS,
    raw: 'rules:\n- topic: /edited\n  metric: gap\n  op: gt\n  threshold: 2.0\n',
    config: { rules: [{ topic: '/edited', metric: 'gap', op: 'gt', threshold: 2 }], derived_rules: null },
  };
  const puts: unknown[] = [];
  mockFetch((body) => {
    puts.push(body);
    return jsonResponse(serverPayload);
  });
  renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  fireEvent.change(screen.getByLabelText('alerts config yaml'), {
    target: { value: 'rules:\n- topic: /edited\n  metric: gap\n  op: gt\n  threshold: 2\n' },
  });
  fireEvent.click(screen.getByTestId('alerts-save-raw'));

  await screen.findByTestId('alerts-saved');
  expect(puts).toEqual([{ raw: 'rules:\n- topic: /edited\n  metric: gap\n  op: gt\n  threshold: 2\n' }]);
  // BOTH views now show what the server wrote (canonical raw + parsed table)…
  expect((screen.getByLabelText('alerts config yaml') as HTMLTextAreaElement).value).toBe(serverPayload.raw);
  expect((screen.getByLabelText('rule topic 0') as HTMLInputElement).value).toBe('/edited');
  // …and nothing is dirty anymore: the form Save is usable again.
  expect(screen.getByTestId('alerts-save')).toBeEnabled();
  expect(screen.queryByTestId('alerts-raw-dirty')).not.toBeInTheDocument();
});

test('the textarea shows what the server wrote even when the response deep-equals the cache', async () => {
  // Structural sharing keeps a byte-identical response's object identity, so
  // the [query.data] effect never fires — the explicit onSuccess re-seed must
  // put the file's truth back on screen instead of the never-sent edit.
  mockFetch(() => jsonResponse({ ...ALERTS }));
  renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  fireEvent.change(screen.getByLabelText('alerts config yaml'), {
    target: { value: ALERTS.raw + '# never sent\n' },
  });
  fireEvent.click(screen.getByTestId('alerts-save-raw'));

  await screen.findByTestId('alerts-saved');
  const ta = screen.getByLabelText('alerts config yaml') as HTMLTextAreaElement;
  expect(ta.value).toBe(ALERTS.raw); // the file's truth, not the illusion
});

test('Save YAML warns when the table has unsaved edits it would discard', async () => {
  mockFetch();
  renderWithClient(<AlertsCard />);
  const topic = await screen.findByLabelText('rule topic 0');

  fireEvent.change(topic, { target: { value: '/table/edited' } });
  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));

  expect(screen.getByTestId('alerts-raw-discard-warn')).toHaveTextContent('discards');
  expect(screen.getByTestId('alerts-save-raw')).toBeEnabled(); // consent, not a dead end
});

// ---------------------------------------------------------------------------
// A REFETCH landing on a dirty buffer. The save path was hardened before
// (justSavedRef + the mutual form/raw guards); the refetch path is a different
// one. It is reached for real: after a drop long enough to fall outside the SSE
// ring buffer the server sends `event: resync` (api_orchestrator/events.py:189)
// and the client answers with a bare `qc.invalidateQueries()` — no key, so
// every query refetches (src/sse/useEventStream.ts:211). The tests below make
// that exact call on the app's own QueryClient.
// ---------------------------------------------------------------------------

/** The file as another terminal just rewrote it. `derived_rules` differs too,
 *  and that block is rendered STRAIGHT from query.data rather than from either
 *  editor buffer — so it is the probe for "the new payload actually reached the
 *  component", independent of whether the buffers were clobbered. */
const ALERTS_CHANGED = {
  ...ALERTS,
  raw: 'rules:\n  - topic: /hsrb/odom\n    metric: gap\n    op: gt\n    threshold: 2\n',
  config: {
    rules: [
      { topic: '/hsrb/odom', metric: 'gap', op: 'gt', threshold: 2, clear_after_s: 1, cooldown_s: 5 },
    ],
    derived_rules: { enabled: true, warn_ratio: 0.55 },
  },
};

/** The reconnect refetch, as the SSE `resync` handler performs it, awaited
 *  until the component has RE-RENDERED with the new payload. Without that wait
 *  a "the buffer survived" assertion passes vacuously: the cache updates inside
 *  act(), but the observer's re-render lands a tick later, so a product that
 *  does clobber would still look innocent at that moment. */
async function resyncRefetch(client: { invalidateQueries: () => Promise<void> }) {
  await act(async () => {
    await client.invalidateQueries();
  });
  await waitFor(() =>
    expect(screen.getByTestId('alerts-derived')).toHaveTextContent('0.55'),
  );
}

test('a reconnect refetch does not silently discard unsaved YAML edits', async () => {
  mockFetch();
  const { client } = renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  const edited = ALERTS.raw + '# threshold raised after the 08-05 run\n';
  fireEvent.change(screen.getByLabelText('alerts config yaml'), { target: { value: edited } });
  expect(screen.getByTestId('alerts-raw-dirty')).toBeInTheDocument();

  // Another terminal rewrites alerts.yaml, then the connection comes back.
  serverAlerts = ALERTS_CHANGED;
  await resyncRefetch(client);

  // The operator's buffer is still theirs, and they are TOLD the file moved
  // rather than having the change applied behind their back.
  expect((screen.getByLabelText('alerts config yaml') as HTMLTextAreaElement).value).toBe(edited);
  expect(screen.getByTestId('alerts-server-changed')).toBeInTheDocument();
});

test('a reconnect refetch does not silently discard unsaved rule-table edits', async () => {
  mockFetch();
  const { client } = renderWithClient(<AlertsCard />);
  const topic = (await screen.findByLabelText('rule topic 0')) as HTMLInputElement;

  fireEvent.change(topic, { target: { value: '/hsrb/hand_camera' } });
  fireEvent.change(screen.getByLabelText('rule threshold 0'), { target: { value: '42' } });

  serverAlerts = ALERTS_CHANGED;
  await resyncRefetch(client);

  expect((screen.getByLabelText('rule topic 0') as HTMLInputElement).value).toBe(
    '/hsrb/hand_camera',
  );
  expect((screen.getByLabelText('rule threshold 0') as HTMLInputElement).value).toBe('42');
  expect(screen.getByTestId('alerts-server-changed')).toBeInTheDocument();
});

test('a CLEAN buffer still adopts the refetched file (the guard is not a freeze)', async () => {
  const fetchSpy = mockFetch();
  const { client } = renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');
  const getsBefore = fetchSpy.mock.calls.filter(([, i]) => (i?.method ?? 'GET') === 'GET').length;

  // No local edits — the newer file is simply the truth now.
  serverAlerts = ALERTS_CHANGED;
  await resyncRefetch(client);

  // The refetch really happened (otherwise the tests above prove nothing).
  const getsAfter = fetchSpy.mock.calls.filter(([, i]) => (i?.method ?? 'GET') === 'GET').length;
  expect(getsAfter).toBeGreaterThan(getsBefore);
  expect((screen.getByLabelText('rule topic 0') as HTMLInputElement).value).toBe('/hsrb/odom');
  expect(screen.queryByTestId('alerts-server-changed')).not.toBeInTheDocument();
});

test('an unchanged refetch leaves a dirty buffer alone and raises no alarm', async () => {
  const fetchSpy = mockFetch();
  const { client } = renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  const edited = ALERTS.raw + '# still mine\n';
  fireEvent.change(screen.getByLabelText('alerts config yaml'), { target: { value: edited } });
  const getsBefore = fetchSpy.mock.calls.filter(([, i]) => (i?.method ?? 'GET') === 'GET').length;

  // The file did NOT change; the reconnect refetch returns the same bytes. There
  // is nothing observable to wait for here (that IS the claim), so the refetch is
  // confirmed by the request count and any late re-render is given two ticks to
  // land before the buffer is checked.
  await act(async () => {
    await client.invalidateQueries();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(
    fetchSpy.mock.calls.filter(([, i]) => (i?.method ?? 'GET') === 'GET').length,
  ).toBeGreaterThan(getsBefore);

  expect((screen.getByLabelText('alerts config yaml') as HTMLTextAreaElement).value).toBe(edited);
  // Nothing moved, so there is nothing to warn about.
  expect(screen.queryByTestId('alerts-server-changed')).not.toBeInTheDocument();
});

test('the operator can take the server copy, losing their edits deliberately', async () => {
  mockFetch();
  const { client } = renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  fireEvent.change(screen.getByLabelText('alerts config yaml'), {
    target: { value: ALERTS.raw + '# mine\n' },
  });
  serverAlerts = ALERTS_CHANGED;
  await resyncRefetch(client);

  fireEvent.click(screen.getByTestId('alerts-load-server'));

  // Both views now hold the server's file, and the notice is gone.
  expect((screen.getByLabelText('alerts config yaml') as HTMLTextAreaElement).value).toBe(
    ALERTS_CHANGED.raw,
  );
  expect((screen.getByLabelText('rule topic 0') as HTMLInputElement).value).toBe('/hsrb/odom');
  expect(screen.queryByTestId('alerts-server-changed')).not.toBeInTheDocument();
  expect(screen.queryByTestId('alerts-raw-dirty')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// What survives the YAML round trip. The server parses `raw`, validates, and
// rewrites the file CANONICALLY from the model (routers/config.py), then hands
// back the rewritten text — so a save is a normalisation, not a write-back of
// what the operator typed. These pin what that costs and that it is stated.
// ---------------------------------------------------------------------------

test('saving anchors shows the EXPANDED file back, and says the file is normalised', async () => {
  // The server's canonical rewrite of an anchored input: both rules survive
  // (meaning preserved) but `&base` / `<<` are gone (structure not preserved).
  const expanded = {
    ...ALERTS,
    raw:
      'rules:\n- topic: /hsrb/joint_states\n  metric: hz\n  op: lt\n  threshold: 15\n' +
      '- topic: /hsrb/odom\n  metric: hz\n  op: lt\n  threshold: 15\n',
    config: {
      rules: [
        { topic: '/hsrb/joint_states', metric: 'hz', op: 'lt', threshold: 15 },
        { topic: '/hsrb/odom', metric: 'hz', op: 'lt', threshold: 15 },
      ],
      derived_rules: null,
    },
  };
  mockFetch(() => jsonResponse(expanded));
  renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  const authored =
    'rules:\n  - &base\n    topic: /hsrb/joint_states\n    metric: hz\n    op: lt\n' +
    '    threshold: 15\n  - <<: *base\n    topic: /hsrb/odom\n';
  fireEvent.change(screen.getByLabelText('alerts config yaml'), { target: { value: authored } });
  fireEvent.click(screen.getByTestId('alerts-save-raw'));

  await screen.findByTestId('alerts-saved');
  // The operator is not left holding an illusion: the textarea is the file now,
  // anchors expanded, so what is on screen is what is on disk.
  const ta = screen.getByLabelText('alerts config yaml') as HTMLTextAreaElement;
  expect(ta.value).toBe(expanded.raw);
  expect(ta.value).not.toContain('&base');
  expect(ta.value).not.toContain('<<');
  // Both rules survived — the meaning is intact, only the structure is not.
  expect((screen.getByLabelText('rule topic 1') as HTMLInputElement).value).toBe('/hsrb/odom');
  // And the rewrite is STATED, not merely observable by noticing the text moved.
  expect(screen.getByTestId('alerts-saved')).toHaveTextContent(/canonical form/i);
  expect(screen.getByTestId('alerts-saved')).toHaveTextContent(/comments/i);
});

test('a YAML parse error shows WHERE it is, not just that it failed', async () => {
  // The tab case. The server rejects loudly with the scanner message in
  // `details.error` — the only part carrying the line and column.
  mockFetch(() =>
    jsonResponse(
      {
        error: {
          code: 'invalid_yaml',
          message: 'Config is not valid YAML.',
          details: {
            error:
              'while scanning for the next token\nfound character \'\\t\' that cannot start any token\n  in "<unicode string>", line 2, column 1',
          },
        },
      },
      422,
    ),
  );
  renderWithClient(<AlertsCard />);
  await screen.findByLabelText('rule topic 0');

  fireEvent.click(screen.getByTestId('alerts-advanced-toggle'));
  fireEvent.change(screen.getByLabelText('alerts config yaml'), {
    target: { value: 'rules:\n\t- topic: /a\n' },
  });
  fireEvent.click(screen.getByTestId('alerts-save-raw'));

  const errors = await screen.findByTestId('alerts-errors');
  expect(errors).toHaveTextContent('line 2, column 1');
});

// ---------------------------------------------------------------------------
// E-34: a slow link. The operator clicks Save, nothing visibly happens, and
// they click again. Two writes of the same buffer would be harmless here (this
// endpoint is last-writer-wins, not compare-and-swap), but a second in-flight
// PUT is still a second chance to interleave with another terminal's save, and
// the button must not look idle while a save is running.
// ---------------------------------------------------------------------------

test('an impatient second click during a slow save does not send a second PUT', async () => {
  let release!: (r: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const puts: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(OPTIONS));
    if (url.includes('/config/alerts')) {
      if (init?.method === 'PUT') {
        puts.push(init.body ? JSON.parse(String(init.body)) : {});
        return held; // still in flight
      }
      return Promise.resolve(jsonResponse(serverAlerts));
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<AlertsCard />);
  const threshold = (await screen.findByLabelText('rule threshold 0')) as HTMLInputElement;
  fireEvent.change(threshold, { target: { value: '20' } });

  const save = screen.getByTestId('alerts-save');
  fireEvent.click(save);
  // The control says what it is doing rather than looking idle …
  await waitFor(() => expect(save).toBeDisabled());
  expect(save).toHaveTextContent('Saving…');

  // … and the impatient second and third clicks cannot queue another write.
  fireEvent.click(save);
  fireEvent.click(save);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(puts).toHaveLength(1);

  release(jsonResponse({ ...ALERTS }));
  await screen.findByTestId('alerts-saved');
  expect(puts).toHaveLength(1);
});
