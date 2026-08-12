// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The key that answers "did the CONFIG behind this selection change?" for the
// seed-once/re-seed-on-robot-switch stores (uiStore.seedRecordTopics,
// cameraStore.seedCameraPanes). Those stores re-seed — discarding whatever the
// operator customised — whenever the key differs from the one they hold, so the
// key has to change for a robot switch and NOT for anything else.
//
// It previously was `JSON.stringify(list)` at each call site, which is ORDER
// SENSITIVE: reordering `default_topics` without adding or removing a single
// entry read as "the robot changed", and the operator's Rec-topic selection was
// silently replaced by the configured set — with the list still showing
// everything they wanted. Order is not semantic for these lists (they select
// WHAT to record / which cameras to open; first-match-wins ordering belongs to
// `expected_hz_patterns` and `topic_qos_overrides`, which are different fields),
// so the identity that matters is the SET.

/** Order-insensitive identity of a configured name list, for seed comparison. */
export function configSeedKey(names: readonly string[]): string {
  return JSON.stringify([...names].sort());
}
