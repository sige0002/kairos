// Static Phase-1 mock data for the Monitor screen. The Episode context strip
// and the Events list both need a Session/Batch/Episode + event model that the
// backend doesn't have yet (Phase 2 — see the Collect screen's useBatchMachine
// for the same caveat); values here mirror the design mock verbatim.

export const MONITOR_CONTEXT = {
  episode: 'Episode #27 (Batch 5)',
  timeRange: '15:29:00 – 15:30:50',
  chip: 'FROM COLLECT WARNING',
};

export type MockEventTone = 'red' | 'amber' | 'info';

export interface MockEvent {
  title: string;
  time: string;
  tone: MockEventTone;
  /** Amber-tinted row background (the mock's in-range warning event). */
  warn?: boolean;
}

export const MOCK_EVENTS: MockEvent[] = [
  { title: 'REC start — Episode #27', time: '15:29:21', tone: 'red' },
  { title: 'Right camera rate drop (Caution)', time: '15:29:11 → 15:29:58', tone: 'amber', warn: true },
  { title: 'IMU gap 0.41 s (Info)', time: '15:30:12', tone: 'info' },
  { title: 'REC stop — saved 412 MB', time: '15:29:49', tone: 'red' },
];
