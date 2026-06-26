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
