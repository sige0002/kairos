// Detail header: selected pipeline's name + real description, a client-side
// lifecycle chip (lifecycle.ts — no backend lifecycle yet) and the promote
// affordance (Candidate only).
import { Badge } from '../../components/ui';
import type { PipelineInfo } from '../../api/types';
import { lifecycleForIndex, lifecycleTone } from './lifecycle';

export function DetailHeader({
  pipeline,
  index,
  onPromote,
}: {
  pipeline: PipelineInfo;
  index: number;
  onPromote: () => void;
}) {
  const lifecycle = lifecycleForIndex(index);
  return (
    <div
      data-testid="detail-header"
      className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]"
    >
      <h2 className="text-[15px] font-bold text-gray-900">{pipeline.id}</h2>
      <Badge tone={lifecycleTone(lifecycle)}>{lifecycle.toUpperCase()}</Badge>
      {pipeline.description && (
        <span className="min-w-0 truncate text-xs text-gray-400" title={pipeline.description}>
          {pipeline.description}
        </span>
      )}
      <div className="flex-1" />
      {lifecycle === 'Candidate' && (
        <button
          type="button"
          onClick={onPromote}
          className="rounded-[9px] bg-teal-600 px-[14px] py-[7px] text-[12.5px] font-bold text-white hover:bg-teal-700"
        >
          Promote to Standard…
        </button>
      )}
    </div>
  );
}
