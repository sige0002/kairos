// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Explicit, read-only setup diagnostic. This is never fetched on mount: the
// Settings control calls it only when the operator asks for current evidence.

import { apiPost } from './client';
import type { SetupCheckReport } from './types';

export function runSetupCheck(): Promise<SetupCheckReport> {
  return apiPost<SetupCheckReport>('/system/setup-check', {});
}
