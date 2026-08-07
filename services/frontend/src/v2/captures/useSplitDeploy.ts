// The one probe that answers "is this a split (robot + recording-PC) deploy?".
//
// Review and Datasets both need it — Review to gate its transfer UI, Datasets
// because §12 obliges the discard dialog to say a copy may remain on the robot,
// but only where that is true. They ask on the same query key with the same
// options, so the two screens share one probe and cannot disagree about the
// deployment they are running on. Read once per session (`staleTime: Infinity`,
// no refetch on focus, no retry) so a test/e2e override is not clobbered by a
// later refetch; on error the honest default (off) stands.
//
// NOTE Collect deliberately does NOT use this: useBatchMachine polls the same
// endpoint on a 60s staleTime because its discard dialog can open long into a
// session. Folding it in here would silently change that refresh policy.

import { useQuery } from '@tanstack/react-query';
import { getTransferStatus } from '../../api/transfer';
import { queryKeys } from '../../api/queryKeys';

/** The raw answer: `undefined` until the probe lands. Callers that must tell
 *  "not asked yet" from "not a split deploy" need this rather than the boolean
 *  below — pushing `undefined` into a boolean flag would assert single-host
 *  before anything answered. */
export function useTransferAvailable(): boolean | undefined {
  const query = useQuery({
    queryKey: queryKeys.transferStatus,
    queryFn: ({ signal }) => getTransferStatus({ signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return query.data?.available;
}

/** Split deploy, decided: anything short of an explicit `true` is not one. */
export function useSplitDeploy(): boolean {
  return useTransferAvailable() === true;
}
