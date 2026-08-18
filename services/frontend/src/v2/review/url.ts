// SPDX-License-Identifier: Apache-2.0
// URL contract for server-owned Review search state.

export interface ReviewSearchUrl {
  q: string;
  operator: string | null;
  batch: string | null;
  quality: 'good' | 'needs_review' | 'not_usable' | null;
  result: 'success' | 'failure' | null;
  condition: string | null;
  from: string | null;
  to: string | null;
  cursor: string | null;
}

const text = (params: URLSearchParams, key: string) => params.get(key)?.trim() || null;
const oneOf = <T extends string>(
  value: string | null,
  values: readonly T[],
): T | null => (value && values.includes(value as T) ? (value as T) : null);
const utcInstant = (value: string | null) =>
  value && /Z$/i.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;

export function readReviewSearch(search = window.location.search): ReviewSearchUrl {
  const params = new URLSearchParams(search);
  return {
    q: text(params, 'q') ?? '',
    operator: text(params, 'operator'),
    batch: text(params, 'batch'),
    quality: oneOf(text(params, 'quality'), ['good', 'needs_review', 'not_usable']),
    result: oneOf(text(params, 'result'), ['success', 'failure']),
    condition: text(params, 'condition'),
    from: utcInstant(text(params, 'from')),
    to: utcInstant(text(params, 'to')),
    cursor: text(params, 'cursor'),
  };
}

export function writeReviewSearch(
  value: ReviewSearchUrl,
  search = window.location.search,
): void {
  // Review owns only its query keys. Keep tab/solo and any future shell route
  // parameters intact: replacing the entire search string can navigate away
  // from Review while an operator changes a filter.
  const params = new URLSearchParams(search);
  for (const [key, raw] of Object.entries(value)) {
    if (raw) params.set(key, raw);
    else params.delete(key);
  }
  const suffix = params.toString();
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${suffix ? `?${suffix}` : ''}${window.location.hash}`,
  );
}
