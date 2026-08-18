// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared read of the catalog's own health. This is deliberately independent of
// the Monitor screen: a Store condition is relevant while an operator is
// recording, reviewing, building a dataset, or watching a validation run.

import { useQuery } from '@tanstack/react-query';
import { getStoreHealth } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import type { StoreHealth } from '../../api/types';
import { STORE_HEALTH_POLL_MS } from '../pollingPolicy';

export function useStoreHealth() {
  return useQuery<StoreHealth>({
    queryKey: queryKeys.storeHealth,
    queryFn: ({ signal }) => getStoreHealth(signal),
    refetchInterval: STORE_HEALTH_POLL_MS,
  });
}
