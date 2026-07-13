import { beforeEach, expect, test } from 'vitest';
import {
  __clearEpisodeOutcomes,
  getEpisodeOutcome,
  removeEpisodeOutcome,
  saveEpisodeOutcome,
  type EpisodeOutcome,
} from './episodeBridge';

function outcome(overrides: Partial<EpisodeOutcome> = {}): EpisodeOutcome {
  return {
    quality: 'good',
    taskResult: 'ok',
    batchNum: 1,
    episodeIndex: 1,
    savedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => __clearEpisodeOutcomes());

test('roundtrip: save then get returns the stored outcome', () => {
  saveEpisodeOutcome('run_1', outcome({ quality: 'review', taskResult: 'fail', failReason: 'Grasp missed', batchNum: 3, episodeIndex: 7 }));
  expect(getEpisodeOutcome('run_1')).toMatchObject({
    quality: 'review',
    taskResult: 'fail',
    failReason: 'Grasp missed',
    batchNum: 3,
    episodeIndex: 7,
  });
});

test('get returns null for an unknown run and for an empty runId', () => {
  expect(getEpisodeOutcome('nope')).toBeNull();
  expect(getEpisodeOutcome('')).toBeNull();
});

test('remove drops a single entry, leaving others intact', () => {
  saveEpisodeOutcome('run_1', outcome());
  saveEpisodeOutcome('run_2', outcome());
  removeEpisodeOutcome('run_1');
  expect(getEpisodeOutcome('run_1')).toBeNull();
  expect(getEpisodeOutcome('run_2')).not.toBeNull();
});

test('a corrupted stored entry is treated as absent (null), not surfaced as garbage', () => {
  window.localStorage.setItem(
    'kairos.v2.episodeOutcomes.v1',
    JSON.stringify({ run_bad: { quality: 'nonsense', batchNum: 'x' } }),
  );
  expect(getEpisodeOutcome('run_bad')).toBeNull();
});

test('size cap: keeps the newest ~500, evicting the oldest by savedAt', () => {
  // 520 entries with strictly increasing savedAt: run_0 is oldest, run_519 newest.
  for (let i = 0; i < 520; i++) {
    saveEpisodeOutcome(`run_${i}`, outcome({ savedAt: 1000 + i, episodeIndex: i }));
  }
  // The 20 oldest are evicted; the newest 500 remain.
  expect(getEpisodeOutcome('run_0')).toBeNull();
  expect(getEpisodeOutcome('run_19')).toBeNull();
  expect(getEpisodeOutcome('run_20')).not.toBeNull();
  expect(getEpisodeOutcome('run_519')).not.toBeNull();
});
