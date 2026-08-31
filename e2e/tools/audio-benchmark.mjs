#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Representative real-stack comparison for issue #44. Run with the E2E stack
// and replay active; it records one five-second take with Audio off and on.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const FRONTEND = process.env.KAIROS_BENCH_FRONTEND ?? 'http://127.0.0.1:28080';
const API = process.env.KAIROS_BENCH_API ?? 'http://127.0.0.1:28000/api/v1';
const MONITOR = process.env.KAIROS_BENCH_MONITOR ?? 'http://127.0.0.1:28001';
const AUDIO_KEY = 'kairos.audio-feedback.v2';
const EVENTS = {
  start: { sound: true, voice: false },
  stop: { sound: true, voice: false },
  success: { sound: true, voice: true },
  failure: { sound: true, voice: true },
  failure_reason: { sound: false, voice: true },
  retake: { sound: true, voice: true },
  save: { sound: true, voice: false },
  invalid: { sound: true, voice: false },
  error: { sound: true, voice: true },
};
const PHRASE_EVENTS = [
  ['start', 'Recording'], ['stop', 'Stopped'], ['success', 'Success'], ['save', 'Saved'],
];
function assetKey(event, phrase) {
  let hash = 2166136261;
  for (const char of phrase) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${event}:${(hash >>> 0).toString(16)}`;
}
const PHRASES = PHRASE_EVENTS.map(([event, text]) => ({
  key: assetKey(event, text), text, language: 'en', voice: 'af_heart', speed: 1,
}));

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json();
}

function cpuSnapshot() {
  const output = execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}}'],
    { encoding: 'utf8' },
  );
  const wanted = /kairos-e2e-(frontend|orchestrator|recorder|monitor|streamer)-1/;
  return Object.fromEntries(output.trim().split('\n').filter((line) => wanted.test(line)).map((line) => {
    const [name, cpu] = line.split(/\s+/);
    return [name.replace(/^kairos-e2e-|-1$/g, ''), Number(cpu.replace('%', ''))];
  }));
}

function systemCpuSnapshot() {
  const values = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: values[3] + values[4], total: values.reduce((sum, value) => sum + value, 0) };
}

function cpuUtilization(before, after) {
  const total = after.total - before.total;
  return total ? Number((100 * (1 - (after.idle - before.idle) / total)).toFixed(1)) : null;
}

async function topicSnapshot() {
  const metrics = await json(`${MONITOR}/metrics`);
  const topics = Object.fromEntries(metrics.topics.map((topic) => [topic.name, topic]));
  const camera = metrics.topics.find((topic) => topic.type === 'sensor_msgs/msg/CompressedImage');
  return {
    camera_topic: camera?.name ?? null,
    camera_fps: camera?.hz ?? null,
    camera_dds_samples_lost: camera?.dds_samples_lost ?? null,
    topics: Object.fromEntries(Object.entries(topics).map(([name, topic]) => [name, topic.hz])),
  };
}

async function ensureOperator(page) {
  const chip = page.getByTestId('operator-chip');
  await chip.waitFor({ timeout: 60_000 });
  if (((await chip.getAttribute('title')) ?? '').startsWith('Operator: ')) return;
  await chip.click();
  await page.getByTestId('operator-input').fill('audio_benchmark');
  await page.getByTestId('operator-input').press('Enter');
}

async function waitForText(locator, pattern, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test((await locator.textContent()) ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${pattern}`);
}

async function runRound(page, enabled, assets) {
  await page.evaluate(({ key, enabled, assets, events }) => {
    localStorage.setItem(key, JSON.stringify({
      version: 2, master: enabled, soundEffects: true, voice: true, volume: 0.45,
      speechRate: 1, language: 'en', voiceName: 'af_heart',
      preparedEngine: 'kokoro-82m',
      preparedModelRevision: audioStatus.model_revision ?? null,
      events, assets,
    }));
  }, { key: AUDIO_KEY, enabled, assets, events: EVENTS });
  await page.reload();
  await ensureOperator(page);
  const phase = page.getByTestId('phase-title');
  await waitForText(phase, /^READY$/, 90_000);
  const armedDeadline = Date.now() + 30_000;
  while (Date.now() < armedDeadline) {
    if ((await json(`${API}/record/status`)).state === 'armed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if ((await json(`${API}/record/status`)).state !== 'armed')
    throw new Error('recorder did not reach the common pre-armed baseline');
  const capturesBefore = new Set((await json(`${API}/captures?include_deleted=true`)).items.map((item) => item.capture_id));
  const beforeTopics = await topicSnapshot();
  const systemCpuBefore = systemCpuSnapshot();
  const startAt = performance.now();
  await page.getByRole('button', { name: /Start recording/ }).click();
  await waitForText(phase, /^RECORDING$/, 120_000);
  const startLatencyMs = performance.now() - startAt;
  const deferred = await json(`${API}/audio/assets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phrases: PHRASES.slice(0, 1) }),
  });
  await page.waitForTimeout(5_000);
  const during = await json(`${API}/record/status`);
  const duringTopics = await topicSnapshot();
  const cpu = cpuSnapshot();
  const stopAt = performance.now();
  await page.getByRole('button', { name: /Stop recording/ }).click();
  await waitForText(phase, /result$/, 180_000);
  const stopLatencyMs = performance.now() - stopAt;
  const save = page.getByTestId('save-episode');
  await save.waitFor({ state: 'visible' });
  await save.click();
  await waitForText(phase, /^(READY|SET COMPLETE)$/, 60_000);
  const systemCpuPercent = cpuUtilization(systemCpuBefore, systemCpuSnapshot());
  const capturesAfter = (await json(`${API}/captures?include_deleted=true`)).items;
  const capture = capturesAfter.find((item) => !capturesBefore.has(item.capture_id));
  if (!capture) throw new Error('the UI recording produced no new capture');
  const recordedTopics = capture.quick_check?.layer1?.topics ?? {};
  const recordedCamera = Object.entries(recordedTopics).find(([name]) => name.includes('image'));
  const ddsLost = Object.values(capture.quick_check?.layer0?.topics ?? {})
    .reduce((sum, topic) => sum + (topic.dds_samples_lost ?? 0), 0);
  const resolvedVoicePlays = await page.evaluate(() => window.__kairosVoicePlays ?? 0);
  return {
    audio: enabled ? 'on' : 'off', start_latency_ms: Math.round(startLatencyMs),
    stop_to_result_ms: Math.round(stopLatencyMs), message_count: capture.message_count,
    bytes: capture.bytes, dds_samples_lost: ddsLost,
    tts_during_recording: deferred.errors, cpu_percent: cpu,
    system_cpu_percent: systemCpuPercent,
    resolved_voice_plays: resolvedVoicePlays,
    camera_fps_before: beforeTopics.camera_fps, camera_fps_during: duringTopics.camera_fps,
    recorded_camera_fps: recordedCamera?.[1]?.avg_hz ?? null,
    camera_dds_samples_lost: duringTopics.camera_dds_samples_lost,
    live_message_count_at_sample: during.message_count,
  };
}

const audioStatus = await json(`${API}/audio/status`);
const cachedAssets = Object.fromEntries(PHRASES.map((phrase) => {
  const id = createHash('sha256')
    .update([
      'v3', 'kokoro-82m', audioStatus.model_revision ?? 'unknown',
      phrase.language, phrase.voice, '1.0', phrase.text,
    ].join('\0'))
    .digest('hex');
  return [phrase.key, `/api/v1/audio/assets/${id}.wav`];
}));
const cacheChecks = await Promise.all(Object.values(cachedAssets).map((url) => fetch(`${API}${url.slice(7)}`)));
let assets = cachedAssets;
if (!cacheChecks.every((response) => response.ok)) {
  const prepareDeadline = Date.now() + 150_000;
  while (Date.now() < prepareDeadline) {
    const state = (await json(`${API}/record/status`)).state;
    if (!['armed', 'recording', 'stopping'].includes(state)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const prepared = await json(`${API}/audio/assets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phrases: PHRASES }),
  });
  if (!prepared.available || prepared.errors.length)
    throw new Error(`voice preparation failed: ${JSON.stringify(prepared)}`);
  assets = Object.fromEntries(prepared.assets.map((asset) => [asset.key, asset.url]));
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__kairosVoicePlays = 0;
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function observedPlay() {
      const source = this.getAttribute('src') || this.src;
      const result = originalPlay.call(this);
      void result.then(() => {
        if (source && !source.startsWith('data:')) window.__kairosVoicePlays += 1;
      });
      return result;
    };
  });
  await page.goto(`${FRONTEND}/?tab=collect`);
  const results = [await runRound(page, false, assets), await runRound(page, true, assets)];
  const [off, on] = results;
  const cameraDelta = off.camera_fps_during && on.camera_fps_during
    ? ((on.camera_fps_during - off.camera_fps_during) / off.camera_fps_during) * 100 : null;
  console.log(JSON.stringify({
    workload: 'real MCAP replay, UI-driven 5 s recording, same browser and stack',
    results,
    on_minus_off: {
      start_latency_ms: on.start_latency_ms - off.start_latency_ms,
      stop_to_result_ms: on.stop_to_result_ms - off.stop_to_result_ms,
      camera_fps_percent: cameraDelta == null ? null : Number(cameraDelta.toFixed(1)),
      dds_samples_lost: on.dds_samples_lost - off.dds_samples_lost,
    },
  }, null, 2));
  if (off.dds_samples_lost > 0 || on.dds_samples_lost > 0)
    process.exitCode = 1;
  if (on.resolved_voice_plays < 1)
    throw new Error('Audio ON produced no successfully resolved Voice playback');
} finally {
  await browser.close();
}
