// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Helpers for the Record tab's config-driven topic picker.
//
// The backend RECORDING_CONFIG exposes `default_topics` (see GET /api/v1/config
// `defaults.default_topics`), which may contain fnmatch glob patterns such as
// "/camera/*/image_raw/compressed". The picker resolves those against the live
// ROS 2 graph (GET /api/v1/topics) so the operator sees concrete, recordable
// topic names — pre-checked when configured — instead of typing them by hand.

/** Whether a config pattern contains a glob metacharacter (`*` or `?`). */
export function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/**
 * fnmatch-style match (Python `fnmatch`: `*` matches any run of characters,
 * including `/`; `?` matches a single character). Plain strings match exactly.
 */
export function matchesTopic(pattern: string, name: string): boolean {
  if (!isGlob(pattern)) return pattern === name;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(name);
}

export interface TopicCandidate {
  name: string;
  /** Message type from graph discovery, if known. */
  type?: string;
  /** Present on the live ROS 2 graph right now. */
  live: boolean;
  /** Matches a `default_topics` entry (recorded/selected by default). */
  configured: boolean;
}

/**
 * Build the picker's candidate list: the union of concrete live topics and
 * concrete (non-glob) configured topics, each flagged `live` / `configured`.
 * Glob defaults contribute by matching live topics (they are not listed as
 * literal rows). Returns candidates sorted by name plus the configured glob
 * patterns that matched nothing live (so the UI can warn they are expected but
 * not currently flowing).
 */
export function buildCandidates(
  defaultTopics: string[],
  liveTopics: { name: string; type?: string }[],
): { candidates: TopicCandidate[]; unmatchedPatterns: string[] } {
  const concreteDefaults = defaultTopics.filter((t) => !isGlob(t));
  const globDefaults = defaultTopics.filter(isGlob);

  const isConfigured = (name: string): boolean =>
    concreteDefaults.includes(name) || globDefaults.some((g) => matchesTopic(g, name));

  const byName = new Map<string, TopicCandidate>();
  for (const t of liveTopics) {
    byName.set(t.name, {
      name: t.name,
      type: t.type,
      live: true,
      configured: isConfigured(t.name),
    });
  }
  // Concrete configured topics that are not live yet still belong in the list
  // (pre-checked) so the operator can record them once they appear.
  for (const name of concreteDefaults) {
    if (!byName.has(name)) {
      byName.set(name, { name, live: false, configured: true });
    }
  }

  const candidates = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const unmatchedPatterns = globDefaults.filter(
    (g) => !liveTopics.some((t) => matchesTopic(g, t.name)),
  );
  return { candidates, unmatchedPatterns };
}
