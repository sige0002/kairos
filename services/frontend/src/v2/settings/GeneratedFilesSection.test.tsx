// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { GeneratedFilesSection } from './GeneratedFilesSection';

const PREVIEW = {
  report_total_bytes: 1_000,
  report_total_files: 10,
  selected_bytes: 800,
  selected_files: 8,
  selected_units: 4,
  selected_captures: 3,
  validation_resets: 0,
  orphaned_units: 0,
  source_unavailable_units: 0,
  protected_active_units: 1,
  scan_errors: 0,
  available_pipelines: ['fast_validation', 'signal_report', 'video_check'],
  by_pipeline: [
    { pipeline: 'video_check', category: 'preview', bytes: 800, files: 8, units: 4 },
  ],
};

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('analyzes with semantic defaults and never sends a filesystem path', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse(PREVIEW));
  renderWithClient(<GeneratedFilesSection />);

  expect(screen.getByTestId('generated-files')).toHaveTextContent('Not analyzed');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze storage' }));

  expect(await screen.findByRole('dialog')).toBeVisible();
  await waitFor(() =>
    expect(screen.getByTestId('cleanup-selected')).toHaveTextContent('800 B'),
  );

  const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
  expect(request).toEqual({
    categories: ['preview', 'analysis'],
    older_than_days: 30,
    pipeline: null,
    capture_scope: 'source_available',
  });
  expect(JSON.stringify(request)).not.toContain('path');
  expect(screen.getByTestId('cleanup-protected')).toHaveTextContent('1 active');
});

test('lets the operator change conditions and requires acknowledgement for validation', async () => {
  const validationPreview = { ...PREVIEW, validation_resets: 2, selected_units: 2 };
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(validationPreview)));
  renderWithClient(<GeneratedFilesSection />);
  fireEvent.click(screen.getByRole('button', { name: 'Analyze storage' }));
  await screen.findByTestId('cleanup-selected');

  fireEvent.click(screen.getByRole('checkbox', { name: /^Validation results/ }));
  fireEvent.change(screen.getByLabelText('Generated before'), {
    target: { value: '90' },
  });
  fireEvent.change(screen.getByLabelText('Capture scope'), {
    target: { value: 'all' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));

  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  const request = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
  expect(request.categories).toEqual(['preview', 'analysis', 'validation']);
  expect(request.older_than_days).toBe(90);
  expect(request.capture_scope).toBe('all');
  expect(screen.getByTestId('validation-reset-warning')).toHaveTextContent(
    '2 captures',
  );
  expect(screen.getByRole('button', { name: /Delete/ })).toBeDisabled();

  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
  expect(screen.getByRole('button', { name: /Delete/ })).toBeEnabled();
});

test('shows the observed cleanup result', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url) => {
    const endpoint = String(_url);
    if (endpoint.endsWith('/cleanup')) {
      return Promise.resolve(
        jsonResponse({
          deleted_bytes: 800,
          deleted_files: 8,
          deleted_units: 4,
          protected_active_units: 1,
          failed_units: [],
          remaining_report_bytes: 200,
        }),
      );
    }
    return Promise.resolve(jsonResponse(PREVIEW));
  });
  renderWithClient(<GeneratedFilesSection />);
  fireEvent.click(screen.getByRole('button', { name: 'Analyze storage' }));
  await screen.findByTestId('cleanup-selected');
  fireEvent.click(screen.getByRole('button', { name: 'Delete 800 B' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Deleted 4 report sets');
  expect(screen.getByRole('status')).toHaveTextContent('800 B');
  expect(fetchSpy).toHaveBeenCalledWith(
    '/api/v1/report-storage/cleanup',
    expect.objectContaining({ method: 'POST' }),
  );
});

test('presents partial cleanup as a recoverable warning with failure details', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url) => {
    if (String(_url).endsWith('/cleanup')) {
      return Promise.resolve(
        jsonResponse({
          deleted_bytes: 600,
          deleted_files: 6,
          deleted_units: 3,
          protected_active_units: 0,
          failed_units: [
            {
              pipeline: 'signal_report',
              capture_id: 'capture-locked',
              message: 'permission denied',
            },
          ],
          remaining_report_bytes: 400,
        }),
      );
    }
    return Promise.resolve(jsonResponse(PREVIEW));
  });
  renderWithClient(<GeneratedFilesSection />);
  fireEvent.click(screen.getByRole('button', { name: 'Analyze storage' }));
  await screen.findByTestId('cleanup-selected');
  fireEvent.click(screen.getByRole('button', { name: 'Delete 800 B' }));

  const warning = await screen.findByRole('alert');
  expect(warning).toHaveTextContent('Cleanup incomplete');
  expect(warning).toHaveTextContent('1 sets failed and remain on disk');
  expect(screen.getByTestId('cleanup-failures')).toHaveTextContent(
    'signal_report / capture-locked: permission denied',
  );
});
