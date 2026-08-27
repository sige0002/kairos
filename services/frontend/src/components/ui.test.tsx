// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared primitives own presentation contracts that should not be copied back
// into a feature: keyboard focus, disabled state, semantic announcements, and
// content-driven layouts all need to remain aligned across the six v2 tabs.

import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  Button,
  Field,
  FieldGroup,
  IconButton,
  Notice,
  Select,
  SettingsSection,
  TextInput,
  Textarea,
} from './ui';

test('Button owns keyboard focus and disabled affordances', () => {
  render(
    <Button disabled type="button">
      Save
    </Button>,
  );

  const button = screen.getByRole('button', { name: 'Save' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('type', 'button');
  expect(button.className).toContain('focus-visible:ring-focus');
  expect(button.className).toContain('disabled:cursor-not-allowed');
});

test('IconButton requires a localized accessible name and keeps its icon hidden', () => {
  render(
    <IconButton label="削除" type="button">
      <svg aria-hidden="true" />
    </IconButton>,
  );

  const button = screen.getByRole('button', { name: '削除' });
  expect(button).toHaveAttribute('aria-label', '削除');
  expect(button).toHaveAttribute('type', 'button');
  expect(button.className).toContain('min-h-11');
  expect(button.className).toContain('focus-visible:ring-focus');
});

test('Notice keeps feature-provided localized recovery content and announces only when asked', () => {
  const { rerender } = render(
    <Notice tone="warning">
      <strong>録画を確認してください。</strong>
    </Notice>,
  );

  expect(screen.getByText('録画を確認してください。')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  rerender(
    <Notice tone="warning" live="polite">
      <span>確認が必要です。</span>
    </Notice>,
  );
  expect(screen.getByRole('status')).toHaveTextContent('確認が必要です。');
  expect(screen.getByRole('status')).not.toHaveAttribute('aria-live');

  rerender(
    <Notice tone="danger" live="assertive">
      <span>復旧手順を確認してください。</span>
    </Notice>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('復旧手順を確認してください。');
  expect(screen.getByRole('alert')).not.toHaveAttribute('aria-live');
});

test('Field gives one native control an accessible name and help/error descriptions', () => {
  render(
    <Field
      id="label-input"
      label="ラベル"
      help="任意です"
      error="形式を確認してください"
    >
      <TextInput />
    </Field>,
  );

  const input = screen.getByLabelText('ラベル');
  expect(input).toHaveAttribute(
    'aria-describedby',
    'label-input-help label-input-error',
  );
  expect(input).toHaveAttribute('aria-errormessage', 'label-input-error');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('任意です')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('形式を確認してください');
});

test('FieldGroup links group-level help and errors to related controls', () => {
  render(
    <FieldGroup
      id="import-labels"
      label="Import labels"
      help="These labels apply to every selected bag."
      error="Choose valid labels before importing."
    >
      <TextInput aria-label="Operator" />
      <TextInput aria-label="Task" />
    </FieldGroup>,
  );

  const group = screen.getByRole('group', { name: 'Import labels' });
  expect(group).toHaveAttribute(
    'aria-describedby',
    'import-labels-help import-labels-error',
  );
  expect(group).toHaveAttribute('aria-errormessage', 'import-labels-error');
  expect(group).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('These labels apply to every selected bag.')).toHaveAttribute(
    'id',
    'import-labels-help',
  );
  expect(screen.getByRole('alert')).toHaveAttribute('id', 'import-labels-error');
});

test('native controls centralise theme, focus, disabled, and shrink-safe styles', () => {
  render(
    <>
      <TextInput aria-label="input" disabled />
      <Select aria-label="select" disabled>
        <option>one</option>
      </Select>
      <Textarea aria-label="textarea" disabled />
    </>,
  );

  for (const name of ['input', 'select', 'textarea']) {
    const control = screen.getByLabelText(name);
    expect(control).toBeDisabled();
    expect(control.className).toContain('min-w-0');
    expect(control.className).toContain('focus-visible:ring-focus/40');
    expect(control.className).toContain('disabled:bg-interaction-disabled');
  }
});

test('SettingsSection keeps a heading and accepts wrapping feature content', () => {
  render(
    <SettingsSection
      title="設定"
      description={<>この説明はローカライズされた長い文章でも折り返せます。</>}
      actions={<Button type="button">保存</Button>}
    >
      <p>設定内容</p>
    </SettingsSection>,
  );

  expect(screen.getByRole('heading', { level: 2, name: '設定' })).toBeInTheDocument();
  expect(
    screen.getByText('この説明はローカライズされた長い文章でも折り返せます。'),
  ).toBeInTheDocument();
  expect(screen.getByText('設定内容')).toBeInTheDocument();
});
