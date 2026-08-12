// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// A failure the operator has to acknowledge, rather than one that fades.
//
// errors.ts sorts readings into two severities, and the difference is not
// decoration: `destructive` is reserved for failures that "must be surfaced as
// a destructive-styled, explicitly dismissed message rather than a passing
// note (§12)". The Datasets screen was routing every refusal into the same
// 2.4-second toast, so a `ledger_unreadable` — the store cannot answer, a file
// needs repairing, and nothing the operator does in this screen will change
// that — flashed past in the same pill as "already a member".
//
// This is driven by the SEVERITY the catalog assigns, never by a code list, so
// it covers `ledger_unwritable` and anything added later with the same
// standing without being taught about them one at a time.

import { Button } from '../../components/ui';
import { readCaptureError } from '../captures/errors';

export function BlockingFailure({
  error,
  onDismiss,
}: {
  error: unknown;
  onDismiss: () => void;
}) {
  if (error == null) return null;
  const reading = readCaptureError(error);
  return (
    <div
      role="alert"
      data-testid="dataset-blocking-failure"
      data-error-code={reading.code}
      className="fixed bottom-[26px] left-1/2 z-[70] flex w-[min(560px,calc(100vw-40px))] -translate-x-1/2 flex-col gap-2 rounded-card border border-red-200 bg-white px-4 py-3 shadow-float"
    >
      <p className="text-[13px] font-semibold leading-relaxed text-red-800">
        {reading.message}
      </p>
      {reading.guidance && (
        <p className="text-[12.5px] leading-relaxed text-gray-600">{reading.guidance}</p>
      )}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-gray-500">({reading.code})</span>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onDismiss} data-testid="dataset-blocking-failure-dismiss">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
