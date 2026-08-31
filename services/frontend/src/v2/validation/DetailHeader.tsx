// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Detail header: selected pipeline's server-reported name + description.
import type { PipelineInfo } from '../../api/types';

export function DetailHeader({ pipeline }: { pipeline: PipelineInfo }) {
  return (
    <div
      data-testid="detail-header"
      className="flex items-center gap-2.5 border-b border-border px-[18px] py-[13px]"
    >
      <h2 className="text-[15px] font-bold text-text-primary">{pipeline.id}</h2>
      {pipeline.description && (
        <span
          className="min-w-0 truncate text-xs text-text-muted"
          title={pipeline.description}
        >
          {pipeline.description}
        </span>
      )}
      <div className="flex-1" />
    </div>
  );
}
