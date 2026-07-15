import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SignalsCard } from './SignalsCard';

const SIGNALS = {
  path: '/config/airoa_hsr/signals/default.yaml',
  raw: 'hidden_field_patterns: ["header.*"]\ndefault_topic: /hsrb/joint_states\nfallback_fields: 4\n',
  config: {
    hidden_field_patterns: ['header.*'],
    default_topic: '/hsrb/joint_states',
    defaults: [{ msg_type: 'sensor_msgs/msg/JointState', fields: ['position[0]', 'position[1]'] }],
    fallback_fields: 4,
  },
};

type PutHandler = (body: unknown) => Response;
const okPut: PutHandler = () => jsonResponse({ ...SIGNALS });

function mockFetch(put: PutHandler = okPut) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/signals')) {
      if (init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        return Promise.resolve(put(body));
      }
      return Promise.resolve(jsonResponse(SIGNALS));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('form-first: seeds default topic, fallback, patterns and per-msg_type rules', async () => {
  mockFetch();
  renderWithClient(<SignalsCard />);

  const topic = (await screen.findByLabelText('signals default topic')) as HTMLInputElement;
  expect(topic.value).toBe('/hsrb/joint_states');
  expect((screen.getByLabelText('signals fallback fields') as HTMLInputElement).value).toBe('4');
  expect((screen.getByLabelText('hidden pattern 0') as HTMLInputElement).value).toBe('header.*');
  expect((screen.getByLabelText('rule msg_type 0') as HTMLInputElement).value).toBe(
    'sensor_msgs/msg/JointState',
  );
  expect((screen.getByLabelText('rule fields 0') as HTMLInputElement).value).toBe(
    'position[0], position[1]',
  );
  // Badge states the honest apply timing.
  expect(screen.getByText('applies immediately')).toBeInTheDocument();
});

test('the raw YAML editor is demoted to a collapsed Advanced disclosure', async () => {
  mockFetch();
  renderWithClient(<SignalsCard />);
  await screen.findByTestId('signals-advanced-toggle');
  expect(screen.queryByLabelText('signals config yaml')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('signals-advanced-toggle'));
  const editor = (await screen.findByLabelText('signals config yaml')) as HTMLTextAreaElement;
  expect(editor.value).toContain('default_topic: /hsrb/joint_states');
});

test('Save posts the edited config and shows the saved banner', async () => {
  const put = vi.fn(okPut);
  mockFetch(put);
  renderWithClient(<SignalsCard />);

  const topic = (await screen.findByLabelText('signals default topic')) as HTMLInputElement;
  fireEvent.change(topic, { target: { value: '/hsrb/odom' } });
  fireEvent.click(screen.getByTestId('signals-save'));

  await screen.findByTestId('signals-saved');
  expect(put).toHaveBeenCalledTimes(1);
  const body = put.mock.calls[0]![0] as { config: { default_topic: string } };
  expect(body.config.default_topic).toBe('/hsrb/odom');
});

test('a 422 surfaces the pydantic field errors inline', async () => {
  const badPut: PutHandler = () =>
    jsonResponse(
      {
        error: {
          code: 'invalid_config',
          message: 'Signals config failed validation.',
          details: { errors: [{ loc: ['fallback_fields'], msg: 'Input should be >= 0' }] },
        },
      },
      422,
    );
  mockFetch(badPut);
  renderWithClient(<SignalsCard />);

  fireEvent.click(await screen.findByTestId('signals-save'));
  const errors = await screen.findByTestId('signals-errors');
  expect(errors).toHaveTextContent('fallback_fields');
  expect(errors).toHaveTextContent('Input should be >= 0');
});
