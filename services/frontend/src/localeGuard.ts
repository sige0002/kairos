// Some Linux Chromium builds report a POSIX-suffixed navigator.language
// ("en-US@posix") that is not a valid BCP-47 tag. uPlot — and anything else
// that feeds navigator.language straight into Intl at MODULE scope — then
// throws during the initial import chain, and the whole console renders as a
// blank page. This module repairs the property before those modules are
// evaluated, so its import must stay FIRST in main.tsx.

/** The repaired tag for an Intl-invalid language, or null when *tag* is fine.
 *  Strips a POSIX `@modifier` suffix and `_` separators; falls back to en-US
 *  when the tag is beyond repair. */
export function repairedLanguageTag(tag: string): string | null {
  if (isIntlValid(tag)) return null;
  const stripped = (tag.split('@')[0] ?? tag).replaceAll('_', '-');
  return isIntlValid(stripped) ? stripped : 'en-US';
}

function isIntlValid(tag: string): boolean {
  try {
    new Intl.NumberFormat(tag);
    return true;
  } catch {
    return false;
  }
}

const repaired = repairedLanguageTag(navigator.language);
if (repaired) {
  // Shadow the Navigator.prototype getter on the instance; every later read
  // (uPlot's module init included) sees the valid tag.
  Object.defineProperty(navigator, 'language', {
    value: repaired,
    configurable: true,
  });
}
