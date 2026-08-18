// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The robot->PC pull channel (split deploy).
//
// The importer sidecar answers its healthz ONLY on a split recording-PC
// deploy, so `available` IS "this is a split deployment" — there is no separate
// flag for the topology. On a single-host deploy this 404s/errors, and the
// honest default (off) stands.

import { apiGet, apiPost, type RequestOptions } from './client';

export interface TransferStatus {
  available?: boolean;
}

export function getTransferStatus(
  opts: RequestOptions = {},
): Promise<TransferStatus> {
  return apiGet<TransferStatus>('/transfer/status', opts);
}

/** Pull one capture's bytes from the robot to this console's data dir. */
export function pullCapture(captureId: string): Promise<unknown> {
  return apiPost('/transfer/pull', { capture_id: captureId });
}

/** One capture's pull state on the importer (S3-1: the failure channel).
 *  `queued → running → ok | failed`; arrival itself is still confirmed by the
 *  capture's replica appearing. 404 = no pull known (importer restarted). */
export interface TransferPullState {
  capture_id: string;
  state: 'queued' | 'running' | 'ok' | 'failed';
  exit_code?: number | null;
  reason?: string | null;
  updated_at?: number;
}

export function getPullStatus(
  captureId: string,
  opts: RequestOptions = {},
): Promise<TransferPullState> {
  return apiGet<TransferPullState>(
    `/transfer/pull/${encodeURIComponent(captureId)}`,
    opts,
  );
}
