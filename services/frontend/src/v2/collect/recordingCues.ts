// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Short, synthetic recording-state cues. No audio asset or network request is
// involved, and the AudioContext is created lazily after an operator gesture.

export type RecordingCueKind = 'start' | 'end' | 'warning';

export interface RecordingCuePlayer {
  readonly supported: boolean;
  unlock: () => Promise<boolean>;
  play: (kind: RecordingCueKind, volume: number) => Promise<boolean>;
  dispose?: () => void;
}

interface Note {
  frequency: number;
  offset: number;
  duration: number;
  type: OscillatorType;
}

const CUES: Record<RecordingCueKind, Note[]> = {
  // A compact rising pair: recording may begin only after this confirmation.
  start: [
    { frequency: 523.25, offset: 0, duration: 0.11, type: 'sine' },
    { frequency: 659.25, offset: 0.11, duration: 0.13, type: 'sine' },
  ],
  // A calmer descending pair: the recorder has finished and released the bag.
  end: [
    { frequency: 659.25, offset: 0, duration: 0.14, type: 'sine' },
    { frequency: 440, offset: 0.14, duration: 0.17, type: 'sine' },
  ],
  // Three low, separated pulses. It asks for attention; the visible alert says
  // what happened and how to recover.
  warning: [
    { frequency: 311.13, offset: 0, duration: 0.1, type: 'triangle' },
    { frequency: 233.08, offset: 0.14, duration: 0.1, type: 'triangle' },
    { frequency: 311.13, offset: 0.28, duration: 0.12, type: 'triangle' },
  ],
};

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const audioWindow = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

export function createRecordingCuePlayer(): RecordingCuePlayer {
  const Context = audioContextConstructor();
  let context: AudioContext | null = null;

  const getContext = (): AudioContext | null => {
    if (!Context) return null;
    context ??= new Context();
    return context;
  };

  const unlock = async (): Promise<boolean> => {
    const ctx = getContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      return ctx.state === 'running';
    } catch {
      return false;
    }
  };

  return {
    supported: Context !== null,
    unlock,
    play: async (kind, volume) => {
      if (!(await unlock())) return false;
      const ctx = getContext();
      if (!ctx) return false;
      const level = Math.max(0, Math.min(1, volume)) * 0.08;
      const startAt = ctx.currentTime + 0.008;
      try {
        for (const note of CUES[kind]) {
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          const noteStart = startAt + note.offset;
          const noteEnd = noteStart + note.duration;
          oscillator.type = note.type;
          oscillator.frequency.setValueAtTime(note.frequency, noteStart);
          gain.gain.setValueAtTime(0.0001, noteStart);
          gain.gain.exponentialRampToValueAtTime(
            Math.max(0.0001, level),
            noteStart + 0.015,
          );
          gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
          oscillator.connect(gain);
          gain.connect(ctx.destination);
          oscillator.start(noteStart);
          oscillator.stop(noteEnd + 0.01);
        }
        return true;
      } catch {
        return false;
      }
    },
    dispose: () => {
      if (!context) return;
      void context.close();
      context = null;
    },
  };
}
