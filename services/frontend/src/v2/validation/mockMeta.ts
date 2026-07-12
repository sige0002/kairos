// PipelineInfo (api/types.ts) has no `version` or `owner` field yet — that's
// Phase 2 metadata the orchestrator doesn't track. Until it does, the rail and
// detail header show a small deterministic placeholder per pipeline (by list
// position) purely for visual completeness, matching the design mock's
// "v1.3.0 · Robot Eng" style meta line. Never treat these as real values.
const OWNERS = ['Robot Eng', 'Robot Eng', 'Robot Eng', 'ML Eng'];

export function mockOwner(index: number): string {
  return OWNERS[index % OWNERS.length]!;
}

export function mockVersion(index: number): string {
  return `v1.${index}.0`;
}
