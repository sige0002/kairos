// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from 'vitest';
import { readCaptureNote } from './captureNote';

test('a cap-stopped take is a notice, not a fault', () => {
  // The backend's own comment says it: the recorder "says no error occurred"
  // and files the capture `completed`. It rides in the manifest's error field
  // only because that is the one free-text field a manifest has.
  const note = readCaptureNote('auto_stopped');
  expect(note.severity).toBe('notice');
  expect(note.label).toBe('Stopped at the configured limit');
});

test('a recorder fault is a fault', () => {
  expect(readCaptureNote('recorder_failed').severity).toBe('fault');
  expect(readCaptureNote('recorder_failed').label).toBeNull();
});

test('a code this build has never seen is treated as a fault', () => {
  // The safe default, and deliberately the pessimistic one. A new code the UI
  // has never seen is exactly when guessing "probably fine" costs most: a
  // genuine fault would arrive looking like a routine note. A new BENIGN code
  // costs only the next reader adding a line to the notice table.
  expect(readCaptureNote('some_future_code').severity).toBe('fault');
  expect(readCaptureNote('').severity).toBe('fault');
  expect(readCaptureNote(null).severity).toBe('fault');
  expect(readCaptureNote(undefined).severity).toBe('fault');
});
