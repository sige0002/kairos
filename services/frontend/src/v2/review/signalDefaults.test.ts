import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse } from '../../test/renderWithClient';
import type { SignalReport } from '../../api/types';
import {
  BUILTIN_SIGNAL_DEFAULTS,
  applyDefaults,
  loadSignalDefaults,
  partitionFields,
  type SignalDefaults,
} from './signalDefaults';

// A signal_report with three topics of different message types.
const REPORT: SignalReport = {
  topics: {
    '/hsrb/joint_states': {
      msg_type: 'sensor_msgs/msg/JointState',
      t_ns: [0, 1],
      fields: {
        'position[0]': [0, 1],
        'position[1]': [0, 1],
        'header.stamp.sec': [0, 1],
        'header.frame_id': [0, 1],
      },
    },
    '/hsrb/command_velocity': {
      msg_type: 'geometry_msgs/msg/Twist',
      t_ns: [0, 1],
      fields: { 'linear.x': [0, 1], 'angular.z': [0, 1] },
    },
    '/misc': {
      msg_type: 'std_msgs/msg/Float64',
      t_ns: [0, 1],
      fields: { data: [0, 1] },
    },
  },
};

const DEFAULTS: SignalDefaults = {
  hiddenFieldPatterns: ['header.*'],
  defaultTopic: '/hsrb/joint_states',
  defaults: [
    {
      msgType: 'sensor_msgs/msg/JointState',
      // position[2] is absent from the report — must be dropped.
      fields: ['position[0]', 'position[1]', 'position[2]'],
    },
    { msgType: 'geometry_msgs/msg/Twist', fields: ['linear.x', 'angular.z'] },
  ],
  fallbackFields: 4,
};

describe('applyDefaults', () => {
  test('uses default_topic and the matching rule, dropping absent fields', () => {
    const { topic, fields } = applyDefaults(REPORT, DEFAULTS);
    expect(topic).toBe('/hsrb/joint_states');
    expect(fields).toEqual(['position[0]', 'position[1]']); // position[2] dropped
  });

  test('falls back to first rule-matching topic when default_topic is absent', () => {
    const d = { ...DEFAULTS, defaultTopic: '/not/in/report' };
    const { topic, fields } = applyDefaults(REPORT, d);
    expect(topic).toBe('/hsrb/joint_states'); // first topic whose msg_type has a rule
    expect(fields).toEqual(['position[0]', 'position[1]']);
  });

  test('a topic whose msg_type has a rule selects that rule (Twist)', () => {
    const d = { ...DEFAULTS, defaultTopic: '/hsrb/command_velocity' };
    const { topic, fields } = applyDefaults(REPORT, d);
    expect(topic).toBe('/hsrb/command_velocity');
    expect(fields).toEqual(['linear.x', 'angular.z']);
  });

  test('no rule → first N non-hidden leaves, honouring hidden patterns', () => {
    const d: SignalDefaults = {
      hiddenFieldPatterns: ['header.*'],
      defaultTopic: '/hsrb/joint_states',
      defaults: [], // no rules at all
      fallbackFields: 4,
    };
    const { topic, fields } = applyDefaults(REPORT, d);
    expect(topic).toBe('/hsrb/joint_states');
    // header.* leaves are excluded; only the two position leaves remain.
    expect(fields).toEqual(['position[0]', 'position[1]']);
  });

  test('fallback respects the fallbackFields count', () => {
    const d: SignalDefaults = {
      hiddenFieldPatterns: [],
      defaultTopic: '/hsrb/joint_states',
      defaults: [],
      fallbackFields: 1,
    };
    expect(applyDefaults(REPORT, d).fields).toHaveLength(1);
  });

  test('empty report → no topic, no fields', () => {
    expect(applyDefaults({ topics: {} } as SignalReport, DEFAULTS)).toEqual({
      topic: null,
      fields: [],
    });
  });
});

describe('loadSignalDefaults', () => {
  beforeEach(() => setApiBase('/api/v1'));
  afterEach(() => vi.restoreAllMocks());

  test('maps the signals aspect payload to SignalDefaults', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        config: {
          hidden_field_patterns: ['header.*'],
          default_topic: '/hsrb/joint_states',
          defaults: [{ msg_type: 'sensor_msgs/msg/JointState', fields: ['position[0]'] }],
          fallback_fields: 3,
        },
        raw: 'yaml',
        path: '/config/airoa_hsr/signals/default.yaml',
      }),
    );
    const d = await loadSignalDefaults();
    expect(d.defaultTopic).toBe('/hsrb/joint_states');
    expect(d.defaults[0]).toEqual({ msgType: 'sensor_msgs/msg/JointState', fields: ['position[0]'] });
    expect(d.fallbackFields).toBe(3);
  });

  test('a 404 (no signals file) falls back to the built-in defaults', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: {} }, 404));
    expect(await loadSignalDefaults()).toEqual(BUILTIN_SIGNAL_DEFAULTS);
  });

  test('a null config falls back to the built-in defaults', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ config: null, raw: null, path: null }),
    );
    expect(await loadSignalDefaults()).toEqual(BUILTIN_SIGNAL_DEFAULTS);
  });
});

describe('partitionFields', () => {
  test('hides pattern matches but keeps a SELECTED hidden field visible', () => {
    const all = ['header.stamp.sec', 'header.stamp.nanosec', 'position[0]', 'position[1]'];
    const { visible, hidden } = partitionFields(all, ['header.stamp.sec'], ['header.*']);
    // the selected hidden field stays togglable; the unselected one is filtered
    expect(visible).toEqual(['header.stamp.sec', 'position[0]', 'position[1]']);
    expect(hidden).toEqual(['header.stamp.nanosec']);
  });

  test('no patterns -> everything visible, nothing hidden', () => {
    const all = ['a.b', 'c'];
    expect(partitionFields(all, [], [])).toEqual({ visible: all, hidden: [] });
  });
});
