// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor > Store — the sub-view wrapper for the store-health panel (§8 / §9-3).
// Its own nav entry rather than a corner of System: SUSPECT and the corrupt list
// are conditions an operator has to be able to walk to, and the Repair action
// that clears SUSPECT is the one control in Monitor that changes the catalog.

import { StoreHealthCard } from './StoreHealthCard';

export function StoreHealthView() {
  return (
    <div
      className="grid flex-1 grid-cols-1 gap-2.5 overflow-auto lg:min-h-0 lg:auto-rows-min"
      data-testid="monitor-store"
    >
      <StoreHealthCard />
    </div>
  );
}
