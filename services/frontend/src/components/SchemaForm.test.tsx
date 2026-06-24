import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { JSONSchema } from '../schema/jsonSchema';
import { SchemaForm } from './SchemaForm';

const RECORD_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['topics'],
  properties: {
    topics: {
      title: 'Topics',
      oneOf: [{ type: 'array', items: { type: 'string' } }, { const: 'all' }],
    },
    compression: { title: 'Compression', enum: ['none', 'zstd'], default: 'none' },
  },
};

test('builds the record_start form and submits "all" topics', () => {
  const onSubmit = vi.fn();
  render(<SchemaForm schema={RECORD_SCHEMA} onSubmit={onSubmit} submitLabel="Start" />);

  fireEvent.click(screen.getByLabelText('all topics'));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ topics: 'all', compression: 'none' }),
  );
});

test('submits an explicit topic list parsed from the textarea', () => {
  const onSubmit = vi.fn();
  render(<SchemaForm schema={RECORD_SCHEMA} onSubmit={onSubmit} submitLabel="Start" />);

  // "select topics" mode is the default (value seeded as []).
  fireEvent.click(screen.getByLabelText('select topics'));
  fireEvent.change(screen.getByPlaceholderText('one per line'), {
    target: { value: '/tf\n/joint_states' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ topics: ['/tf', '/joint_states'] }),
  );
});

test('enum renders a select with the default selected', () => {
  const onSubmit = vi.fn();
  render(<SchemaForm schema={RECORD_SCHEMA} onSubmit={onSubmit} submitLabel="Start" />);
  const select = screen.getByLabelText('Compression') as HTMLSelectElement;
  expect(select.value).toBe('none');
  fireEvent.change(select, { target: { value: 'zstd' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ compression: 'zstd' }),
  );
});
