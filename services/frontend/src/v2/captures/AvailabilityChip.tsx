// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The one chip every screen uses to say where a capture's bytes are.
// Semantics (including why `null` replica is not "missing") live in
// availability.ts; this only renders them.

import { Badge } from '../../components/ui';
import { availabilityOf, type Availability } from './availability';
import type { CaptureListItem } from '../../api/types';

export function AvailabilityChip({
  capture,
  testId,
}: {
  capture: CaptureListItem;
  testId?: string;
}) {
  const availability = availabilityOf(capture);
  return <AvailabilityBadge availability={availability} testId={testId} />;
}

export function AvailabilityBadge({
  availability,
  testId,
}: {
  availability: Availability;
  testId?: string;
}) {
  return (
    <Badge
      tone={availability.tone}
      dot
      // The kind is on the element so a test (and a screenshot diff) can assert
      // WHICH state is shown, not just that some chip rendered.
      data-testid={testId ?? 'capture-availability'}
      data-availability={availability.kind}
      className="whitespace-nowrap"
      title={availability.detail}
    >
      {availability.label}
    </Badge>
  );
}
