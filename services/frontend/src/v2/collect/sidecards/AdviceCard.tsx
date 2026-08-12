// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Advice for next episode: the static collection-technique tips, paged by the
// operator. The only card here that reads nothing live.

import { Card, cn } from '../../../components/ui';
import { ADVICE_ITEMS, type BatchMachine } from '../useBatchMachine';
import { SIDE_PAD } from '../compact';

export function AdviceCard({ machine }: { machine: BatchMachine }) {
  const advice = ADVICE_ITEMS[machine.adviceIdx] ?? ADVICE_ITEMS[0]!;
  const single = ADVICE_ITEMS.length <= 1;
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2 [@media(max-height:860px)]:gap-1',
        SIDE_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Advice for next episode
        </h2>
        <div className="flex-1" />
        {/* With one tip the pager is not a disabled control, it is a costume —
            "1 / 1" plus arrows reads as a generator that happens to have one
            suggestion, when this card is a static tip (advice generation is
            deliberately unimplemented). Show paging only when there is paging. */}
        {!single && (
          <>
            <button
              type="button"
              onClick={machine.advicePrev}
              aria-label="previous advice"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-chip border border-gray-200 bg-white text-[11px] text-gray-500"
            >
              ‹
            </button>
            <span className="font-mono text-[11px] text-gray-500">
              {machine.adviceIdx + 1} / {ADVICE_ITEMS.length}
            </span>
            <button
              type="button"
              onClick={machine.adviceNext}
              aria-label="next advice"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-chip border border-gray-200 bg-white text-[11px] text-gray-500"
            >
              ›
            </button>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1 rounded-control border border-teal-200 bg-teal-50 px-3 py-2.5 [@media(max-height:860px)]:py-1.5">
        <div className="flex items-center gap-2">
          <span className="rounded-chip bg-teal-100 px-2 py-0.5 text-[10.5px] font-bold text-teal-700">
            {advice.badge}
          </span>
          <span className="text-[12.5px] font-semibold text-teal-950">
            {advice.title}
          </span>
        </div>
        {/* Full advice at roomy heights; clamped to keep the card short on laptops. */}
        <span className="text-xs leading-relaxed text-teal-700 [@media(max-height:860px)]:line-clamp-2">
          {advice.detail}
        </span>
      </div>
    </Card>
  );
}
