// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

export function TopicSearch({
  query,
  onChange,
  testId,
}: {
  query: string;
  onChange: (query: string) => void;
  testId: string;
}) {
  const { t } = useTranslation('monitor');
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        ref={inputRef}
        type="search"
        aria-label={t('topics.searchLabel')}
        data-testid={testId}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('topics.searchPlaceholder')}
        className="h-8 w-full min-w-0 rounded-control border border-border bg-surface px-3 font-mono text-[12px] text-text-primary outline-none placeholder:font-sans placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-focus"
      />
      {query && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
          className="shrink-0 rounded-control px-2 py-1 text-xs text-text-secondary hover:bg-surface-muted focus-visible:outline-accent"
        >
          {t('topics.clearSearch')}
        </button>
      )}
    </div>
  );
}
