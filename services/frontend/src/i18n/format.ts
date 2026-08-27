// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The only operator-facing Intl boundary. Call from render-time presentation;
// App subscribes to useLocale so a language change rerenders existing screens.

import { currentLocale, i18n, localeForIntl } from './index';

function intlLocale(): string {
  return localeForIntl(currentLocale());
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(intlLocale()).format(value);
}

export function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

export function formatTime(value: Date): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

export function formatCaptureDate(value: Date): string {
  const date = new Intl.DateTimeFormat(intlLocale(), {
    day: 'numeric',
    month: 'short',
  }).format(value);
  return `${date} ${formatTime(value)}`;
}

export function formatShortDate(value: Date): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function formatList(values: string[]): string {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type: 'conjunction' }).format(
    values,
  );
}

export function formatMemberCount(count: number): string {
  return i18n.t('common:count.member', { count, formattedCount: formatNumber(count) });
}

export function formatMemberLabel(count: number): string {
  return i18n.t('common:count.memberLabel', { count });
}
