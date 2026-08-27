// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
/** The dark bottom-center toast pill shared by every v2 screen.
 *
 *  The outer live region stays mounted whether or not a toast is showing:
 *  screen readers only announce content that CHANGES inside an existing
 *  `aria-live` container, so mounting the container together with the message
 *  would drop the announcement. Tests address the pill via `testId`, which is
 *  only in the DOM while a message is visible — absence checks keep working.
 */
export function Toast({ message, testId }: { message: string; testId?: string }) {
  return (
    <div role="status" aria-live="polite">
      {message ? (
        <div
          data-testid={testId}
          className="fixed bottom-[26px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-control bg-text-primary px-[18px] py-[11px] text-sm font-medium text-text-inverse shadow-float"
        >
          <span className="h-[7px] w-[7px] rounded-sm bg-status-live-accent" />
          {message}
        </div>
      ) : null}
    </div>
  );
}
