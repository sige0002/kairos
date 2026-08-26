// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The configurable external-control mapping (#43): which LOGICAL action each of
// the three external channels (LEFT / CENTER / RIGHT) performs in each Collect
// state. Pure module: the shape, the safe default, the per-state allowlists,
// and the validation that turns any stored/server blob into a trusted config
// (or null — the caller falls back to the default).
//
// The config is a candidate selector, never a permission grant: the resolver
// (externalActions.ts) still re-checks the live phase and every guard, and the
// state machine remains the authority. An action that is not valid for a state
// cannot even be stored — validation enforces the allowlist — so "bypass a
// guard" is not representable, and a channel set to `none` simply does nothing.
//
// No hardware is assumed: the channels are logical. Any keyboard chord, macro
// pad, or programmable foot pedal that can emit three inputs may drive them.

export const EXTERNAL_CONTROL_STATES = [
  'ready',
  'recording',
  'result',
  'failure_reason',
] as const;
export type ExternalControlState = (typeof EXTERNAL_CONTROL_STATES)[number];

export const EXTERNAL_CONTROL_SLOTS = ['left', 'center', 'right'] as const;
export type ExternalControlSlot = (typeof EXTERNAL_CONTROL_SLOTS)[number];

/** The logical actions a channel may perform. `none` = the press does nothing. */
export type ExternalControlAction =
  | 'none'
  | 'start'
  | 'stop'
  | 'success_save'
  | 'failure'
  | 'retake'
  | 'reason_slot_1'
  | 'reason_slot_2'
  | 'reason_slot_3';

export interface ExternalControlStateMap {
  left: ExternalControlAction;
  center: ExternalControlAction;
  right: ExternalControlAction;
}

export interface ExternalControlsConfig {
  schema_version: 1;
  ready: ExternalControlStateMap;
  recording: ExternalControlStateMap;
  result: ExternalControlStateMap;
  failure_reason: ExternalControlStateMap;
}

/** The actions a channel may perform in each state, besides `none`. This is
 *  the menu the Settings editor offers and the validator (frontend AND server)
 *  enforces — actions outside it do not exist for that state. */
export const ALLOWED_ACTIONS: Record<
  ExternalControlState,
  readonly ExternalControlAction[]
> = {
  ready: ['start'],
  recording: ['stop'],
  result: ['success_save', 'failure', 'retake'],
  failure_reason: ['reason_slot_1', 'reason_slot_2', 'reason_slot_3'],
};

/** The safe default (#43, backward-compatible): the fixed table of #36,
 *  including CENTER = Retake in RESULT. A config that is absent (never set)
 *  resolves to this silently. */
export const DEFAULT_EXTERNAL_CONTROLS: ExternalControlsConfig = {
  schema_version: 1,
  ready: { left: 'none', center: 'start', right: 'none' },
  recording: { left: 'none', center: 'stop', right: 'none' },
  result: { left: 'failure', center: 'retake', right: 'success_save' },
  failure_reason: {
    left: 'reason_slot_1',
    center: 'reason_slot_2',
    right: 'reason_slot_3',
  },
};

const ALL_ACTIONS: readonly ExternalControlAction[] = [
  'none',
  'start',
  'stop',
  'success_save',
  'failure',
  'retake',
  'reason_slot_1',
  'reason_slot_2',
  'reason_slot_3',
];

function isAction(value: unknown): value is ExternalControlAction {
  return (
    typeof value === 'string' && (ALL_ACTIONS as readonly string[]).includes(value)
  );
}

function hasExactKeys(
  obj: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(obj);
  return keys.length === expected.length && expected.every((key) => key in obj);
}

/** Validate + normalize an untrusted blob (localStorage or server) into a
 *  trusted config, or null when it is not a usable mapping.
 *
 * Rules:
 *  - `schema_version` must be 1 (an unknown version is not misread as v1)
 *  - exactly the four known states, each with exactly the three slots
 *  - every value is a known action ALLOWED in that state
 *  - a non-`none` action is assigned to at most one channel per state
 *    (two channels must not perform the same destructive action)
 */
export function normalizeExternalControls(raw: unknown): ExternalControlsConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!hasExactKeys(obj, ['schema_version', ...EXTERNAL_CONTROL_STATES])) return null;
  if (obj.schema_version !== 1) return null;

  const out = {} as Record<ExternalControlState, ExternalControlStateMap>;
  for (const state of EXTERNAL_CONTROL_STATES) {
    const stateRaw = obj[state];
    if (typeof stateRaw !== 'object' || stateRaw === null) return null;
    const stateObj = stateRaw as Record<string, unknown>;
    if (!hasExactKeys(stateObj, EXTERNAL_CONTROL_SLOTS)) return null;
    const map = {} as Record<ExternalControlSlot, ExternalControlAction>;
    const allowed = new Set<string>(['none', ...ALLOWED_ACTIONS[state]]);
    const used = new Set<string>();
    for (const slot of EXTERNAL_CONTROL_SLOTS) {
      const value = stateObj[slot];
      if (!isAction(value) || !allowed.has(value)) return null;
      if (value !== 'none') {
        if (used.has(value)) return null;
        used.add(value);
      }
      map[slot] = value;
    }
    out[state] = map;
  }
  return { schema_version: 1, ...out };
}

/** Deep copy so the store's config is never mutated in place by a caller. */
export function cloneExternalControls(
  config: ExternalControlsConfig,
): ExternalControlsConfig {
  return {
    schema_version: 1,
    ready: { ...config.ready },
    recording: { ...config.recording },
    result: { ...config.result },
    failure_reason: { ...config.failure_reason },
  };
}
