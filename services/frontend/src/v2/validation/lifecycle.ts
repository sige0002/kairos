// Pipeline lifecycle (Standard / Candidate / Experimental / Draft) is a
// Phase 2 backend concept (docs/specs/ja/dora_plugins.md has no lifecycle
// field on PipelineInfo yet). Until the orchestrator reports one, the rail
// assigns a lifecycle client-side, deterministically, from list position: the
// first (real) pipeline is the trusted baseline (Standard), the second is
// treated as a promotion candidate (Candidate, so "Promote to Standard…" has
// something to demo), and everything else is Experimental. This is purely a
// UI affordance — it never changes what a pipeline actually does or which
// captures it's allowed to touch.
import type { Tone } from '../../components/ui';

export type Lifecycle = 'Standard' | 'Candidate' | 'Experimental' | 'Draft';

export function lifecycleForIndex(index: number): Lifecycle {
  if (index === 0) return 'Standard';
  if (index === 1) return 'Candidate';
  return 'Experimental';
}

export function lifecycleTone(lifecycle: Lifecycle): Tone {
  switch (lifecycle) {
    case 'Standard':
      return 'green';
    case 'Candidate':
      return 'teal';
    case 'Experimental':
      return 'amber';
    default:
      return 'gray';
  }
}
