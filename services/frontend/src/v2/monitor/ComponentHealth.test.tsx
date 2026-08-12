// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useUiStore } from '../../store/uiStore';
import { ComponentHealth } from './ComponentHealth';

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState({ sseStatus: 'closed', monitorBridge: null });
});

test('orchestrator health reflects the live SSE status, monitor health the bridge', () => {
  useUiStore.setState({ sseStatus: 'open', monitorBridge: 'up' });
  render(<ComponentHealth />);
  expect(screen.getByTestId('health-orchestrator')).toHaveTextContent('reachable');
  expect(screen.getByTestId('health-monitor')).toHaveTextContent('reachable');
});

test('a down bridge and a closed SSE read as unreachable (honest, not fabricated)', () => {
  useUiStore.setState({ sseStatus: 'closed', monitorBridge: 'down' });
  render(<ComponentHealth />);
  expect(screen.getByTestId('health-orchestrator')).toHaveTextContent('unreachable');
  expect(screen.getByTestId('health-monitor')).toHaveTextContent('unreachable');
});

test('an unreported bridge is "not reported", never guessed', () => {
  useUiStore.setState({ sseStatus: 'connecting', monitorBridge: null });
  render(<ComponentHealth />);
  expect(screen.getByTestId('health-monitor')).toHaveTextContent('not reported');
});

test('says plainly that recorder/streamer readiness is server-side (/readyz) — and never fetches it', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  render(<ComponentHealth />);
  expect(screen.getByTestId('component-health')).toHaveTextContent('/readyz');
  expect(screen.getByTestId('component-health')).toHaveTextContent(/recorder \/ streamer/);
  // /readyz is not browser-reachable in the shipped topology, so we must not call it.
  expect(fetchSpy).not.toHaveBeenCalled();
});
