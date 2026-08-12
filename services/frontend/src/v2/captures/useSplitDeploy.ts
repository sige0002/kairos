// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The one probe that answers "is this a split (robot + recording-PC) deploy?".
//
// Review, Datasets and Collect all need it — Review to gate its transfer UI,
// the others because §12 obliges a discard dialog/toast to say a copy may
// remain on the robot, but only where that can be true. Every screen asks
// through here, on one query key with ONE policy: the same fact used to be
// probed under three different policies (read-once-no-retry here, a 60 s poll
// in useBatchMachine, a third in Datasets), so which truth a dialog showed
// depended on which screen asked first (timing sweep S3-7).
//
// Failure handling is the point (S3-7): the old `retry: false` +
// `staleTime: Infinity` pair meant one failed probe pinned `undefined` — and
// every boolean consumer collapsed that to "not a split deploy" — until the
// component happened to remount, suppressing the §12 disclosure on a
// DESTRUCTIVE dialog. Retries stay on and the answer goes stale on the normal
// clock, so a blip heals itself; and the disclosure consumers use
// `useRobotCopyMayRemain`, which fails toward disclosing.

import { useQuery } from '@tanstack/react-query';
import { getTransferStatus } from '../../api/transfer';
import { queryKeys } from '../../api/queryKeys';

/** The raw answer: `undefined` until the probe lands (or while it is failing).
 *  Callers that must tell "not asked yet" from "not a split deploy" need this
 *  rather than the booleans below — pushing `undefined` into a boolean flag
 *  would assert single-host before anything answered. */
export function useTransferAvailable(): boolean | undefined {
  const query = useQuery({
    queryKey: queryKeys.transferStatus,
    queryFn: ({ signal }) => getTransferStatus({ signal }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return query.data?.available;
}

/** Split deploy, CONFIRMED: gates features that only exist on a split deploy
 *  (the transfer/pull UI). Anything short of an explicit `true` — including
 *  "the probe is failing" — is not one, because showing transfer controls
 *  that cannot work helps nobody. */
export function useSplitDeploy(): boolean {
  return useTransferAvailable() === true;
}

/** §12's question, failed safe: could a copy of a discarded capture remain on
 *  the robot? True for a confirmed split deploy AND while the answer is
 *  unknown — a destructive dialog must over-disclose, not under-disclose, when
 *  the probe cannot answer. Only a confirmed single-host deploy suppresses
 *  the note. */
export function useRobotCopyMayRemain(): boolean {
  return useTransferAvailable() !== false;
}
