// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The external-control mapping config (#43) as pure tests: the shape, the safe
// default, the per-state allowlists, and the validation that keeps an invalid
// stored value from ever reaching a press. No React, no storage.

import { describe, expect, test } from 'vitest';
import {
  ALLOWED_ACTIONS,
  cloneExternalControls,
  DEFAULT_EXTERNAL_CONTROLS,
  EXTERNAL_CONTROL_SLOTS,
  EXTERNAL_CONTROL_STATES,
  normalizeExternalControls,
  type ExternalControlsConfig,
} from './externalControlConfig';

function full(overrides: Partial<ExternalControlsConfig> = {}): ExternalControlsConfig {
  return cloneExternalControls({ ...DEFAULT_EXTERNAL_CONTROLS, ...overrides });
}

describe('the safe default', () => {
  test('reproduces the #36 fixed table including CENTER Retake', () => {
    expect(DEFAULT_EXTERNAL_CONTROLS).toEqual({
      schema_version: 1,
      ready: { left: 'none', center: 'start', right: 'none' },
      recording: { left: 'none', center: 'stop', right: 'none' },
      result: { left: 'failure', center: 'retake', right: 'success_save' },
      failure_reason: {
        left: 'reason_slot_1',
        center: 'reason_slot_2',
        right: 'reason_slot_3',
      },
    });
  });

  test('is itself valid (the default must always pass its own rules)', () => {
    expect(normalizeExternalControls(DEFAULT_EXTERNAL_CONTROLS)).toEqual(
      DEFAULT_EXTERNAL_CONTROLS,
    );
  });

  test('every state offers `none` plus exactly its allowlisted actions', () => {
    expect(ALLOWED_ACTIONS.ready).toEqual(['start']);
    expect(ALLOWED_ACTIONS.recording).toEqual(['stop']);
    expect(ALLOWED_ACTIONS.result).toEqual(['success_save', 'failure', 'retake']);
    expect(ALLOWED_ACTIONS.failure_reason).toEqual([
      'reason_slot_1',
      'reason_slot_2',
      'reason_slot_3',
    ]);
  });
});

describe('normalizeExternalControls — a valid config passes through', () => {
  test('the default normalizes to itself', () => {
    expect(normalizeExternalControls(DEFAULT_EXTERNAL_CONTROLS)).toEqual(
      DEFAULT_EXTERNAL_CONTROLS,
    );
  });

  test('every documented rearrangement is valid', () => {
    // Issue example A: everything on CENTER except RESULT's sides.
    expect(
      normalizeExternalControls({
        schema_version: 1,
        ready: { left: 'none', center: 'start', right: 'none' },
        recording: { left: 'none', center: 'stop', right: 'none' },
        result: { left: 'failure', center: 'retake', right: 'success_save' },
        failure_reason: {
          left: 'reason_slot_1',
          center: 'reason_slot_2',
          right: 'reason_slot_3',
        },
      }),
    ).not.toBeNull();
    // Issue example B: LEFT-driven Start/Stop/Retake, reasons permuted.
    expect(
      normalizeExternalControls({
        schema_version: 1,
        ready: { left: 'start', center: 'none', right: 'none' },
        recording: { left: 'stop', center: 'none', right: 'none' },
        result: { left: 'retake', center: 'success_save', right: 'failure' },
        failure_reason: {
          left: 'reason_slot_3',
          center: 'reason_slot_1',
          right: 'reason_slot_2',
        },
      }),
    ).not.toBeNull();
  });

  test('an all-None state is valid (the mouse remains a full fallback)', () => {
    const config = full({
      result: { left: 'none', center: 'none', right: 'none' },
    });
    expect(normalizeExternalControls(config)).toEqual(config);
  });
});

describe('normalizeExternalControls — invalid configs are rejected', () => {
  test('non-objects and arrays are rejected', () => {
    for (const raw of [null, undefined, 1, 'ready', ['ready']]) {
      expect(normalizeExternalControls(raw)).toBeNull();
    }
  });

  test('an unknown schema version is not misread as v1', () => {
    const config = { ...full(), schema_version: 2 };
    expect(normalizeExternalControls(config)).toBeNull();
  });

  test('a missing state or slot is rejected (no partial guesses)', () => {
    const noResult = { ...full() } as Record<string, unknown>;
    delete noResult.result;
    expect(normalizeExternalControls(noResult)).toBeNull();

    const noRight = full();
    delete (noRight.ready as Partial<typeof noRight.ready>).right;
    expect(normalizeExternalControls(noRight)).toBeNull();
  });

  test('an unknown state or slot is rejected rather than silently ignored', () => {
    expect(normalizeExternalControls({ ...full(), paused: {} })).toBeNull();
    expect(
      normalizeExternalControls({
        ...full(),
        ready: { ...full().ready, fourth: 'none' },
      }),
    ).toBeNull();
  });

  test('an action outside the state allowlist is rejected', () => {
    // `retake` in READY, `start` in RECORDING, `stop` in RESULT, a reason
    // slot in READY — each is a real action, just not in that state.
    expect(
      normalizeExternalControls(
        full({ ready: { left: 'retake', center: 'start', right: 'none' } }),
      ),
    ).toBeNull();
    expect(
      normalizeExternalControls(
        full({ recording: { left: 'start', center: 'stop', right: 'none' } }),
      ),
    ).toBeNull();
    expect(
      normalizeExternalControls(
        full({ result: { left: 'stop', center: 'none', right: 'success_save' } }),
      ),
    ).toBeNull();
    expect(
      normalizeExternalControls(
        full({ ready: { left: 'reason_slot_1', center: 'start', right: 'none' } }),
      ),
    ).toBeNull();
  });

  test('an unknown action string is rejected', () => {
    const config = full() as unknown as {
      result: { left: string; center: string; right: string };
    };
    config.result.left = 'save';
    expect(normalizeExternalControls(config)).toBeNull();
  });

  test('the same action on two channels of one state is rejected', () => {
    for (const action of [
      'start',
      'stop',
      'success_save',
      'failure',
      'retake',
    ] as const) {
      const state =
        action === 'start' ? 'ready' : action === 'stop' ? 'recording' : 'result';
      expect(
        normalizeExternalControls(
          full({ [state]: { left: action, center: action, right: 'none' } }),
        ),
      ).toBeNull();
    }
    expect(
      normalizeExternalControls(
        full({
          failure_reason: {
            left: 'reason_slot_2',
            center: 'reason_slot_2',
            right: 'none',
          },
        }),
      ),
    ).toBeNull();
  });

  test('`none` may repeat freely (it is not an action)', () => {
    const config = full({
      ready: { left: 'none', center: 'none', right: 'none' },
    });
    expect(normalizeExternalControls(config)).toEqual(config);
  });
});

describe('cloneExternalControls', () => {
  test('copies deeply — mutating the clone never touches the source', () => {
    const source = full();
    const copy = cloneExternalControls(source);
    copy.ready.center = 'none';
    copy.failure_reason.left = 'none';
    expect(source.ready.center).toBe('start');
    expect(source.failure_reason.left).toBe('reason_slot_1');
  });
});

describe('the state/slot vocabulary is stable', () => {
  test('four states, three channels each', () => {
    expect(EXTERNAL_CONTROL_STATES).toEqual([
      'ready',
      'recording',
      'result',
      'failure_reason',
    ]);
    expect(EXTERNAL_CONTROL_SLOTS).toEqual(['left', 'center', 'right']);
  });
});
