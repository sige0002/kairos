/* global URL, console, process */

// Keep the appearance boundary at Tailwind's semantic token layer. This is a
// deliberately small regression guard, not a general-purpose CSS parser.
//
// Literal colors remain allowed only where the color describes content rather
// than the console chrome: camera/video overlays and canvas chart series.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../src/', import.meta.url);
// Keep this allowlist exact: each entry names a content value that cannot use a
// semantic console role. Adding a file alone must never exempt its whole UI.
const contentColorValues = new Map([
  [
    'features/probe/UplotChart.tsx',
    new Set(['#0891b2', '#0d9488', '#16a34a', '#2563eb', '#7c3aed', '#9ca3af', '#d97706', '#dc2626', '#fb7185']),
  ],
  [
    'v2/collect/CameraTile.tsx',
    new Set([
      '#0d9488', '#1f2937', '#243042', '#d97706', '#dc2626',
      'bg-gray-800', 'bg-gray-900/70', 'bg-gray-900/75', 'bg-gray-900/80',
      'border-gray-500', 'border-gray-600', 'border-t-teal-400', 'text-gray-200', 'text-gray-300',
      'text-gray-900', 'text-teal-200', 'text-white',
    ]),
  ],
  [
    'v2/collect/Cameras.tsx',
    new Set(['#1f2937', 'bg-gray-900/75', 'bg-gray-900/80', 'text-gray-300', 'text-white']),
  ],
  ['v2/captures/inspect.tsx', new Set(['bg-black'])],
  [
    'v2/monitor/chartSeries.ts',
    new Set(['#0891b2', '#0d9488', '#16a34a', '#7c3aed', '#d97706', '#fb7185']),
  ],
  [
    'v2/tokens.ts',
    new Set([
      '#0d9488', '#0f766e', '#111827', '#15803d', '#16a34a', '#374151', '#6b7280', '#92400e',
      '#99f6e4', '#9ca3af', '#b45309', '#b91c1c', '#bbf7d0', '#ccfbf1', '#d97706', '#dc2626',
      '#dcfce7', '#e5e7eb', '#f0fdf4', '#f0fdfa', '#f3f4f6', '#f9fafb', '#fde68a', '#fecaca',
      '#fef2f2', '#fef3c7', '#fffbeb',
    ]),
  ],
]);
const literalUtility =
  /(?:bg|text|border(?:-(?:t|r|b|l|x|y))?|ring|outline|divide|from|via|to|fill|stroke|caret|accent|shadow)-(?:white|black|gray|slate|zinc|neutral|teal|emerald|green|red|rose|amber|yellow|orange|blue|cyan|indigo|violet|purple|pink)(?:-[0-9]{2,3})?(?:\/[0-9]+)?/g;
const literalHex = /(?<!&)#[0-9a-f]{3,8}\b/gi;

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

const violations = [];
for (const file of await files(root.pathname)) {
  if (!/\.(?:ts|tsx|css)$/.test(file) || /\.test\.[jt]sx?$/.test(file)) continue;
  const path = relative(root.pathname, file);
  const source = await readFile(file, 'utf8');
  for (const [pattern, kind] of [
    [literalUtility, 'literal palette utility'],
    [literalHex, 'literal hex color'],
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (contentColorValues.get(path)?.has(match[0].toLowerCase())) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${path}:${line}: ${kind}: ${match[0]}`);
    }
  }
}

if (violations.length) {
  console.error('Use semantic theme tokens for console UI colors:\n' + violations.join('\n'));
  process.exitCode = 1;
}
