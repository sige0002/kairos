import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ApiError } from '../api/client';
import type { ApiErrorBody } from '../api/types';
import { ErrorMessage, errorText } from './ErrorMessage';

function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  const body = { error: { code, message, details } } as ApiErrorBody;
  return new ApiError(status, body, 'fallback');
}

test('errorText is the human sentence, with no code prefixed to it', () => {
  // m9: leading with `capture_busy: …` puts an identifier nobody asked for in
  // front of the only part the operator can read.
  expect(errorText(apiError(409, 'capture_busy', 'a job holds it'))).toBe(
    'a job holds it',
  );
  expect(errorText(new Error('plain'))).toBe('plain');
  expect(errorText('not an error')).toBe('not an error');
});

test('the code still travels, on its own muted trailing line', () => {
  render(<ErrorMessage error={apiError(409, 'capture_busy', 'a job holds it')} />);
  const alert = screen.getByRole('alert');
  // Readable first, quotable second — and the element carries the code for
  // tests and for anyone reading the DOM.
  expect(alert).toHaveAttribute('data-error-code', 'capture_busy');
  expect(alert.textContent).toBe('a job holds it(capture_busy)');
});

test('a service-unreachable cause is shown beneath the message', () => {
  // The only generic deeper-cause key the orchestrator attaches: the message
  // names the service, `cause` says what the transport actually did.
  render(
    <ErrorMessage
      error={apiError(503, 'recorder_unreachable', 'The recorder is unreachable.', {
        cause: 'ConnectError: connection refused',
      })}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('The recorder is unreachable.');
  expect(screen.getByRole('alert')).toHaveTextContent('connection refused');
  expect(screen.getByRole('alert')).toHaveAttribute(
    'data-error-code',
    'recorder_unreachable',
  );
});

test('a cause already contained in the message is not echoed twice', () => {
  render(
    <ErrorMessage
      error={apiError(503, 'x_unreachable', 'failed: connection refused', {
        cause: 'connection refused',
      })}
    />,
  );
  // The cause is already in the message, so it is not repeated; the code still
  // trails.
  expect(screen.getByRole('alert').textContent).toBe(
    'failed: connection refused(x_unreachable)',
  );
});

test('per-code details are left to the guidance layer, not rendered raw here', () => {
  // capture_busy carries lease_owner, which v2/captures/errors.ts turns into a
  // sentence naming the job to wait for. Echoing the bare value here would be a
  // second, dumber rendering of the same payload.
  render(
    <ErrorMessage
      error={apiError(409, 'capture_busy', 'a job holds this capture', {
        lease_owner: 'digest-job-7',
        capture_id: 'cap-1',
      })}
    />,
  );
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('a job holds this capture');
  expect(alert).not.toHaveTextContent('digest-job-7');
});

test('a details payload with no cause renders the message alone', () => {
  render(<ErrorMessage error={apiError(404, 'capture_not_found', 'gone', {})} />);
  expect(screen.getByRole('alert').textContent).toBe('gone(capture_not_found)');
});
