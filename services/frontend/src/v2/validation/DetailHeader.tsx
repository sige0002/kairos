// Detail header: selected pipeline's name, version + lifecycle chips, the
// promote affordance (Candidate only), and a mock owner line.
import { Badge } from '../../components/ui';
import type { PipelineInfo } from '../../api/types';
import { lifecycleForIndex, lifecycleTone } from './lifecycle';
import { mockOwner, mockVersion } from './mockMeta';

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
      <span className="text-[15px] font-bold text-gray-900">{pipeline.id}</span>
      <Badge tone="teal" mono>
        {mockVersion(index)}
      </Badge>
      <Badge tone={lifecycleTone(lifecycle)}>{lifecycle.toUpperCase()}</Badge>
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
      <span className="text-xs text-gray-400">owner: {mockOwner(index)}</span>
    </div>
  );
}
