// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  AppearanceProvider,
  useAppearance,
} from './theme';
import { Badge, Button, Card, Modal } from './components/ui';
import { ErrorMessage } from './components/ErrorMessage';

type MatchMediaController = {
  setDark: (dark: boolean) => void;
};

function installMatchMedia(initialDark: boolean): MatchMediaController {
  let matches = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      get matches() {
        return matches;
      },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (
        _: 'change',
        listener: (event: MediaQueryListEvent) => void,
      ) => listeners.add(listener),
      removeEventListener: (
        _: 'change',
        listener: (event: MediaQueryListEvent) => void,
      ) => listeners.delete(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  );
  return {
    setDark(dark) {
      matches = dark;
      const event = {
        matches: dark,
        media: '(prefers-color-scheme: dark)',
      } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

function AppearanceProbe() {
  const { appearance, resolvedTheme, setAppearance } = useAppearance();
  return (
    <>
      <output data-testid="appearance">{`${appearance}:${resolvedTheme}`}</output>
      <button type="button" onClick={() => setAppearance('light')}>
        light
      </button>
      <button type="button" onClick={() => setAppearance('dark')}>
        dark
      </button>
      <button type="button" onClick={() => setAppearance('system')}>
        system
      </button>
    </>
  );
}

function renderAppearance() {
  return render(
    <AppearanceProvider>
      <AppearanceProbe />
    </AppearanceProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appearance preference', () => {
  test('System resolves from the browser preference and reacts when it changes', () => {
    const media = installMatchMedia(false);
    renderAppearance();

    expect(screen.getByTestId('appearance')).toHaveTextContent('system:light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    act(() => media.setDark(true));
    expect(screen.getByTestId('appearance')).toHaveTextContent('system:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  test('an explicit appearance overrides the system preference', () => {
    const media = installMatchMedia(true);
    renderAppearance();

    act(() => screen.getByRole('button', { name: 'light' }).click());
    expect(screen.getByTestId('appearance')).toHaveTextContent('light:light');
    act(() => media.setDark(false));
    expect(screen.getByTestId('appearance')).toHaveTextContent('light:light');

    act(() => screen.getByRole('button', { name: 'dark' }).click());
    expect(screen.getByTestId('appearance')).toHaveTextContent('dark:dark');
    act(() => media.setDark(false));
    expect(screen.getByTestId('appearance')).toHaveTextContent('dark:dark');
  });

  test('persists the selected appearance and restores it after a remount', () => {
    installMatchMedia(false);
    const first = renderAppearance();
    act(() => screen.getByRole('button', { name: 'dark' }).click());
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark');

    first.unmount();
    renderAppearance();
    expect(screen.getByTestId('appearance')).toHaveTextContent('dark:dark');
  });

  test('keeps the selected theme for the page when browser storage rejects it', () => {
    installMatchMedia(false);
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Storage disabled', 'SecurityError');
      });
    renderAppearance();

    act(() => screen.getByRole('button', { name: 'dark' }).click());
    expect(screen.getByTestId('appearance')).toHaveTextContent('dark:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(storage).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY, 'dark');
  });
});

test('shared primitives keep semantic roles in both resolved themes', () => {
  installMatchMedia(false);
  const { container } = render(
    <AppearanceProvider>
      <AppearanceProbe />
      <Card>card</Card>
      <Button>save</Button>
      <Badge tone="green">connected</Badge>
      <ErrorMessage error={new Error('Not saved.')} />
      <Modal open onClose={() => {}} title="Confirm">
        message
      </Modal>
    </AppearanceProvider>,
  );

  expect(container.querySelector('.bg-surface')).toBeInTheDocument();
  expect(container.querySelector('.bg-accent')).toBeInTheDocument();
  expect(container.querySelector('.bg-status-success-bg')).toBeInTheDocument();
  expect(container.querySelector('.bg-status-danger-bg')).toBeInTheDocument();
  expect(container.querySelector('.bg-surface-elevated')).toBeInTheDocument();
  expect(container.querySelector('.bg-scrim')).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');

  act(() => screen.getByRole('button', { name: 'dark' }).click());
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(container.querySelector('.bg-surface')).toBeInTheDocument();
  expect(container.querySelector('.bg-status-success-bg')).toBeInTheDocument();
});
