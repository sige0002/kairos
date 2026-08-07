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
