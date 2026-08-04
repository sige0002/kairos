import { fireEvent, screen, waitFor } from '@testing-library/react';
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

type PutHandler = (body: unknown) => Response;
const okPut: PutHandler = () => jsonResponse({ ...ALERTS });

function mockFetch(put: PutHandler = okPut) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/alerts')) {
      if (init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        return Promise.resolve(put(body));
      }
      return Promise.resolve(jsonResponse(ALERTS));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
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
