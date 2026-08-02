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

test('errorText prefixes the code so an operator can quote it', () => {
  expect(errorText(apiError(409, 'capture_busy', 'a job holds it'))).toBe(
    'capture_busy: a job holds it',
  );
  expect(errorText(new Error('plain'))).toBe('plain');
  expect(errorText('not an error')).toBe('not an error');
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
  expect(screen.getByRole('alert')).toHaveTextContent(
    'recorder_unreachable: The recorder is unreachable.',
  );
  expect(screen.getByRole('alert')).toHaveTextContent('connection refused');
});

test('a cause already contained in the message is not echoed twice', () => {
  render(
    <ErrorMessage
      error={apiError(503, 'x_unreachable', 'failed: connection refused', {
        cause: 'connection refused',
      })}
    />,
  );
  // One line only — the cause is already in the message, so a second line would
  // say the same thing twice.
  expect(screen.getByRole('alert').textContent).toBe(
    'x_unreachable: failed: connection refused',
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
  expect(alert).toHaveTextContent('capture_busy: a job holds this capture');
  expect(alert).not.toHaveTextContent('digest-job-7');
});

test('a details payload with no cause renders the message alone', () => {
  render(<ErrorMessage error={apiError(404, 'capture_not_found', 'gone', {})} />);
  expect(screen.getByRole('alert').textContent).toBe('capture_not_found: gone');
});
