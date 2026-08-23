// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The external-operator state table (#36) as pure tests: the meaning of each
// slot in every Collect state, the key mapping, and the label derivation the
// HUD renders. No React, no hardware — the table IS the contract.

import { describe, expect, test } from 'vitest';
import type { FailureShortcuts } from '../../plans';
import {
  EXTERNAL_ACTION_KEYS,
  externalActionMeaningLabel,
  externalActionSlotForEvent,
  resolveExternalActionMeanings,
  type ExternalActionContext,
} from './externalActions';

const SHORTCUTS: FailureShortcuts = {
  left: 'Grasp missed',
  center: 'Object dropped',
  right: 'Wrong placement',
};
const EMPTY: FailureShortcuts = { left: null, center: null, right: null };

function ctx(overrides: Partial<ExternalActionContext>): ExternalActionContext {
  return {
    phase: 'ready',
    pendingTask: null,
    isSavingReview: false,
    takeoverActive: false,
    startEnabled: true,
    stopEnabled: true,
    shortcuts: SHORTCUTS,
    ...overrides,
  };
}

describe('resolveExternalActionMeanings — the #36 state table', () => {
  test('READY: CENTER starts, the sides do nothing', () => {
    const m = resolveExternalActionMeanings(ctx({}));
    expect(m.center.kind).toBe('start');
    expect(m.left.kind).toBe('disabled');
    expect(m.right.kind).toBe('disabled');
  });

  test('READY with a blocked start shows disabled, not a promised start', () => {
    const m = resolveExternalActionMeanings(ctx({ startEnabled: false }));
    expect(m.center.kind).toBe('disabled');
  });

  test('RECORDING: CENTER stops, the sides do nothing', () => {
    const m = resolveExternalActionMeanings(ctx({ phase: 'recording' }));
    expect(m.center.kind).toBe('stop');
    expect(m.left.kind).toBe('disabled');
    expect(m.right.kind).toBe('disabled');
  });

  test('RECORDING inside the stop floor shows disabled (floor not passed)', () => {
    const m = resolveExternalActionMeanings(
      ctx({ phase: 'recording', stopEnabled: false }),
    );
    expect(m.center.kind).toBe('disabled');
  });

  test('ARMING / SAVING / QUICK CHECK: everything is disabled', () => {
    for (const phase of ['arming', 'saving', 'quickcheck'] as const) {
      const m = resolveExternalActionMeanings(ctx({ phase }));
      expect(m.left.kind).toBe('disabled');
      expect(m.center.kind).toBe('disabled');
      expect(m.right.kind).toBe('disabled');
    }
  });

  test('RESULT before Failure: LEFT Failure, CENTER Retake, RIGHT saves Success', () => {
    for (const pendingTask of ['ok', null] as const) {
      const m = resolveExternalActionMeanings(ctx({ phase: 'result', pendingTask }));
      expect(m.left.kind).toBe('pick-failure');
      expect(m.center.kind).toBe('retake');
      expect(m.right.kind).toBe('save-success');
    }
  });

  test('RESULT with Failure selected: the slots ARE the current Task reasons', () => {
    const m = resolveExternalActionMeanings(
      ctx({ phase: 'result', pendingTask: 'fail' }),
    );
    expect(m.left).toEqual({ kind: 'save-failure-reason', reason: 'Grasp missed' });
    expect(m.center).toEqual({ kind: 'save-failure-reason', reason: 'Object dropped' });
    expect(m.right).toEqual({ kind: 'save-failure-reason', reason: 'Wrong placement' });
  });

  test('a Task switch changes the three effective reasons', () => {
    const other: FailureShortcuts = {
      left: 'Robot fault',
      center: null,
      right: 'Object misplaced at start',
    };
    const before = resolveExternalActionMeanings(
      ctx({ phase: 'result', pendingTask: 'fail' }),
    );
    const after = resolveExternalActionMeanings(
      ctx({ phase: 'result', pendingTask: 'fail', shortcuts: other }),
    );
    expect(before.left).toEqual({
      kind: 'save-failure-reason',
      reason: 'Grasp missed',
    });
    expect(after.left).toEqual({ kind: 'save-failure-reason', reason: 'Robot fault' });
    expect(after.center.kind).toBe('unassigned');
    expect(after.right).toEqual({
      kind: 'save-failure-reason',
      reason: 'Object misplaced at start',
    });
  });

  test('unassigned slots resolve to unassigned — never a guessed reason', () => {
    const m = resolveExternalActionMeanings(
      ctx({ phase: 'result', pendingTask: 'fail', shortcuts: EMPTY }),
    );
    expect(m.left.kind).toBe('unassigned');
    expect(m.center.kind).toBe('unassigned');
    expect(m.right.kind).toBe('unassigned');
  });

  test('failure reasons are unreachable before Failure is selected', () => {
    // READY and RECORDING must never expose a save-failure-reason meaning.
    for (const phase of ['ready', 'recording'] as const) {
      const m = resolveExternalActionMeanings(ctx({ phase }));
      for (const slot of ['left', 'center', 'right'] as const) {
        expect(m[slot].kind).not.toBe('save-failure-reason');
      }
    }
    // …and a RESULT with Success pre-selected offers Failure/Success, not reasons.
    const m = resolveExternalActionMeanings(
      ctx({ phase: 'result', pendingTask: 'ok' }),
    );
    expect(m.left.kind).toBe('pick-failure');
  });

  test('PAUSED / ENDED / COMPLETED: everything is disabled', () => {
    for (const phase of ['paused', 'ended', 'completed'] as const) {
      const m = resolveExternalActionMeanings(ctx({ phase }));
      expect(m.left.kind).toBe('disabled');
      expect(m.center.kind).toBe('disabled');
      expect(m.right.kind).toBe('disabled');
    }
  });

  test('takeover disables everything, even in an otherwise active state', () => {
    for (const phase of ['ready', 'recording', 'result'] as const) {
      const m = resolveExternalActionMeanings(
        ctx({
          phase,
          pendingTask: phase === 'result' ? 'fail' : null,
          takeoverActive: true,
        }),
      );
      expect(m.left.kind).toBe('disabled');
      expect(m.center.kind).toBe('disabled');
      expect(m.right.kind).toBe('disabled');
    }
  });

  test('an action in flight disables every external slot regardless of phase', () => {
    for (const phase of ['ready', 'recording', 'result'] as const) {
      const m = resolveExternalActionMeanings(
        ctx({
          phase,
          pendingTask: phase === 'result' ? 'fail' : null,
          isSavingReview: true,
        }),
      );
      expect(m.left.kind).toBe('disabled');
      expect(m.center.kind).toBe('disabled');
      expect(m.right.kind).toBe('disabled');
    }
  });
});

describe('the documented key chords', () => {
  test('Ctrl+Alt+1/2/3 map to LEFT / CENTER / RIGHT', () => {
    expect(
      externalActionSlotForEvent({
        ctrlKey: true,
        altKey: true,
        metaKey: false,
        shiftKey: false,
        code: 'Digit1',
      }),
    ).toBe('left');
    expect(
      externalActionSlotForEvent({
        ctrlKey: true,
        altKey: true,
        metaKey: false,
        shiftKey: false,
        code: 'Digit2',
      }),
    ).toBe('center');
    expect(
      externalActionSlotForEvent({
        ctrlKey: true,
        altKey: true,
        metaKey: false,
        shiftKey: false,
        code: 'Digit3',
      }),
    ).toBe('right');
  });

  test('no modifier, extra modifiers, or other keys are not external actions', () => {
    const base = { metaKey: false, shiftKey: false, code: 'Digit1' };
    expect(
      externalActionSlotForEvent({ ...base, ctrlKey: false, altKey: false }),
    ).toBeNull();
    expect(
      externalActionSlotForEvent({ ...base, ctrlKey: true, altKey: false }),
    ).toBeNull();
    expect(
      externalActionSlotForEvent({ ...base, ctrlKey: false, altKey: true }),
    ).toBeNull();
    expect(
      externalActionSlotForEvent({
        ...base,
        ctrlKey: true,
        altKey: true,
        metaKey: true,
      }),
    ).toBeNull();
    expect(
      externalActionSlotForEvent({
        ...base,
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
    ).toBeNull();
    expect(
      externalActionSlotForEvent({
        ...base,
        ctrlKey: true,
        altKey: true,
        code: 'Digit4',
      }),
    ).toBeNull();
    expect(
      externalActionSlotForEvent({
        ...base,
        ctrlKey: true,
        altKey: true,
        code: 'KeyA',
      }),
    ).toBeNull();
    // A bare printable key is never an external action.
    expect(
      externalActionSlotForEvent({
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        code: 'Digit1',
      }),
    ).toBeNull();
  });

  test('the chords are documented and collision-free with the existing layer', () => {
    expect(EXTERNAL_ACTION_KEYS).toEqual({
      left: 'Ctrl+Alt+1',
      center: 'Ctrl+Alt+2',
      right: 'Ctrl+Alt+3',
    });
    // None of the existing single-key shortcuts (R/S/Space/Esc/?/Enter) is a
    // chord, and none of the chords is a bare printable key.
    for (const chord of Object.values(EXTERNAL_ACTION_KEYS)) {
      expect(chord.length).toBeGreaterThan(4);
    }
  });
});

describe('externalActionMeaningLabel (the HUD words)', () => {
  test('each meaning reads as its plain-language effect', () => {
    expect(externalActionMeaningLabel({ kind: 'disabled' })).toBe('—');
    expect(externalActionMeaningLabel({ kind: 'start' })).toBe('Start');
    expect(externalActionMeaningLabel({ kind: 'stop' })).toBe('Stop');
    expect(externalActionMeaningLabel({ kind: 'pick-failure' })).toBe('Failure');
    expect(externalActionMeaningLabel({ kind: 'retake' })).toBe('Retake');
    expect(externalActionMeaningLabel({ kind: 'save-success' })).toBe('Success + Save');
    expect(
      externalActionMeaningLabel({
        kind: 'save-failure-reason',
        reason: 'Grasp missed',
      }),
    ).toBe('Grasp missed');
    expect(externalActionMeaningLabel({ kind: 'unassigned' })).toBe('Unassigned');
  });
});
