// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { formatDateTime, formatList, formatMemberCount, formatNumber } from './format';
import {
  I18nProvider,
  LOCALE_STORAGE_KEY,
  i18n,
  readStoredLocale,
  useLocale,
} from './index';
import { useState } from 'react';

function WorkflowProbe() {
  const { locale, preferencePersistent, setLocale } = useLocale();
  const [draft, setDraft] = useState('active review draft');
  return (
    <div>
      <output data-testid="locale">{locale}</output>
      <output data-testid="tab">{i18n.t('common:tabs.collect')}</output>
      <output data-testid="date">
        {formatDateTime(new Date('2026-08-12T11:26:03Z'))}
      </output>
      <output data-testid="number">{formatNumber(1204)}</output>
      <output data-testid="members">{formatMemberCount(1204)}</output>
      <output data-testid="list">{formatList(['A', 'B', 'C'])}</output>
      <output data-testid="persistent">{String(preferencePersistent)}</output>
      <input
        aria-label="workflow draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="button" onClick={() => setLocale('ja')}>
        Japanese
      </button>
      <button type="button" onClick={() => setLocale('en')}>
        English
      </button>
    </div>
  );
}

beforeEach(async () => {
  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  await i18n.changeLanguage('en');
  document.documentElement.lang = 'en';
});

afterEach(async () => {
  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  await i18n.changeLanguage('en');
  document.documentElement.lang = 'en';
  vi.restoreAllMocks();
});

test('switches copy, document language, plural/count, and Intl immediately without remounting work', async () => {
  render(
    <I18nProvider>
      <WorkflowProbe />
    </I18nProvider>,
  );
  const initialDate = screen.getByTestId('date').textContent;

  fireEvent.change(screen.getByRole('textbox', { name: 'workflow draft' }), {
    target: { value: 'mid-recording choice' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }));
  });

  expect(screen.getByTestId('locale')).toHaveTextContent('ja');
  expect(screen.getByTestId('tab')).toHaveTextContent('収録');
  expect(screen.getByTestId('members')).toHaveTextContent('1,204 件');
  expect(screen.getByTestId('date').textContent).not.toBe(initialDate);
  expect(screen.getByTestId('number')).toHaveTextContent(formatNumber(1204));
  expect(screen.getByTestId('list')).toHaveTextContent('A、B、C');
  expect(screen.getByRole('textbox', { name: 'workflow draft' })).toHaveValue(
    'mid-recording choice',
  );
  expect(document.documentElement.lang).toBe('ja');
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ja');
});

test('falls back to English for an unavailable runtime language', async () => {
  await i18n.changeLanguage('fr');
  expect(i18n.t('common:tabs.collect')).toBe('Collect');
});

test('plural messages retain locale-formatted counts in both supported languages', async () => {
  await i18n.changeLanguage('en');
  expect(formatMemberCount(1204)).toBe('1,204 members');
  await i18n.changeLanguage('ja');
  expect(formatMemberCount(1204)).toBe('1,204 件');
});

test('localizes primary workflow terminology while preserving raw diagnostics', async () => {
  await i18n.changeLanguage('ja');
  expect(i18n.t('collect:title')).toBe('収録');
  expect(i18n.t('review:title')).toBe('レビュー');
  expect(i18n.t('datasets:title')).toBe('データセット');
  expect(i18n.t('validation:title')).toBe('検証');
  expect(i18n.t('common:status.needsCheck')).toBe('要確認');
  expect(i18n.t('common:status.excluded')).toBe('除外済み');
  expect(i18n.t('collect:retake')).toBe('撮り直し');
  expect(i18n.t('common:status.failureReason', { reason: 'raw backend detail' })).toBe(
    '失敗理由: raw backend detail',
  );
});

test('keeps an in-page selection when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied');
  });
  expect(readStoredLocale()).toEqual({ locale: 'en', storageAvailable: false });

  render(
    <I18nProvider>
      <WorkflowProbe />
    </I18nProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }));
  });
  expect(screen.getByTestId('locale')).toHaveTextContent('ja');
  expect(screen.getByTestId('persistent')).toHaveTextContent('false');
});
