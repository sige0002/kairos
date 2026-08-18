// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { JSONSchema } from '../../schema/jsonSchema';
import { PipelineForm } from './PipelineForm';

const TEMPLATE_OPTIONS = [
  { id: 'airoa_hsr', name: 'airoa_hsr', version: 1, required_topics: [{ name: '/tf' }] },
];

// A loss_report-shaped schema (OL-4.3): array of globs + a number threshold,
// proving the auto-form renders the config-driven params generically.
const LOSS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    target_topics: { type: 'array', items: { type: 'string' }, default: ['/hsrb/*'] },
    gap_threshold_multiplier: { type: 'number', default: 5 },
  },
};

test('renders array + number params and emits parsed values', () => {
  const onChange = vi.fn();
  render(
    <PipelineForm schema={LOSS_SCHEMA} value={{ target_topics: ['/hsrb/*'], gap_threshold_multiplier: 5 }} onChange={onChange} />,
  );

  // Array field shows globs comma-joined; editing parses back to a string list.
  const topics = screen.getByLabelText('target_topics') as HTMLInputElement;
  expect(topics.value).toBe('/hsrb/*');
  fireEvent.change(topics, { target: { value: '/a, /b' } });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ target_topics: ['/a', '/b'] }),
  );

  // Number field round-trips as a number.
  const mult = screen.getByLabelText('gap_threshold_multiplier') as HTMLInputElement;
  expect(mult.value).toBe('5');
  fireEvent.change(mult, { target: { value: '10' } });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ gap_threshold_multiplier: 10 }),
  );
});

test('renders a `template` field as a catalog select, not a text box', () => {
  const schema: JSONSchema = {
    type: 'object',
    required: ['template'],
    properties: { template: { type: 'string' } },
  };
  const onChange = vi.fn();
  render(
    <PipelineForm
      schema={schema}
      value={{ template: 'airoa_hsr' }}
      onChange={onChange}
      templateOptions={TEMPLATE_OPTIONS}
    />,
  );
  const select = screen.getByLabelText('template');
  expect(select.tagName).toBe('SELECT');
  expect(select.querySelector('option[value="airoa_hsr"]')).not.toBeNull();
});

// x-suggest (dora_plugins.md §2.5): a string param annotated by the backend
// schema renders as a select of context suggestions (e.g. the target run's
// camera topics) — no hand-typing topic paths — and falls back to a plain
// text input when no suggestions are available (honest degradation).
const VIDEO_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['topic'],
  properties: {
    topic: { type: 'string', 'x-suggest': 'camera_topics' },
  },
};

test('an x-suggest string param renders as a select of the provided suggestions', () => {
  const onChange = vi.fn();
  render(
    <PipelineForm
      schema={VIDEO_SCHEMA}
      value={{ topic: '/cam/head/compressed' }}
      onChange={onChange}
      suggestions={{ camera_topics: ['/cam/head/compressed', '/cam/hand/compressed'] }}
    />,
  );
  const select = screen.getByLabelText('topic') as HTMLSelectElement;
  expect(select.tagName).toBe('SELECT');
  expect(select.value).toBe('/cam/head/compressed');
  fireEvent.change(select, { target: { value: '/cam/hand/compressed' } });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ topic: '/cam/hand/compressed' }),
  );
});

test('a current value not in the suggestions stays selectable (preset survival)', () => {
  render(
    <PipelineForm
      schema={VIDEO_SCHEMA}
      value={{ topic: '/legacy/cam' }}
      onChange={vi.fn()}
      suggestions={{ camera_topics: ['/cam/head/compressed'] }}
    />,
  );
  const select = screen.getByLabelText('topic') as HTMLSelectElement;
  expect(select.value).toBe('/legacy/cam');
  expect([...select.options].map((o) => o.value)).toEqual([
    '/legacy/cam',
    '/cam/head/compressed',
  ]);
});

test('an x-suggest param without suggestions falls back to a text input', () => {
  render(
    <PipelineForm schema={VIDEO_SCHEMA} value={{ topic: '' }} onChange={vi.fn()} />,
  );
  const field = screen.getByLabelText('topic') as HTMLInputElement;
  expect(field.tagName).toBe('INPUT');
  expect(field.type).toBe('text');
});
