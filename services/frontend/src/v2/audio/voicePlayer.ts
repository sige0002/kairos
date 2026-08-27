// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// One persistent media element is shared by Settings previews and Collect.
// Priming and later post-await playback therefore use the same browser-owned
// element, including on engines whose autoplay permission is element-specific.

const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACA';

let element: HTMLAudioElement | null = null;

function getElement(): HTMLAudioElement {
  element ??= new Audio(SILENT_WAV);
  return element;
}

export function unlockVoicePlayer(): Promise<boolean> {
  try {
    const audio = getElement();
    audio.src = SILENT_WAV;
    audio.volume = 0;
    return audio.play().then(
      () => {
        audio.pause();
        audio.currentTime = 0;
        return true;
      },
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function playVoiceAsset(
  url: string,
  volume: number,
  onEnded?: () => void,
): Promise<boolean> {
  try {
    const audio = getElement();
    audio.pause();
    audio.src = url;
    audio.volume = volume;
    audio.onended = onEnded ?? null;
    return audio.play().then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function stopVoicePlayer(): void {
  try {
    if (!element) return;
    element.pause();
    element.onended = null;
    element.removeAttribute('src');
  } catch {
    // Audio is advisory; teardown never affects an operator action.
  } finally {
    element = null;
  }
}
