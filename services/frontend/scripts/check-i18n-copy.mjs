// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
/* global console, process */
//
// Guard the localized Console v2 boundaries against *new* inline display copy.
// This is intentionally a syntax check, not an English-language detector: it
// only inspects literal JSX text and literal accessible/display attributes.
// User/backend values, code identifiers, diagnostics, and generated third-party
// UI therefore remain outside its scope. Existing deliberate literals are kept
// in the reviewed allowlist with an exact count per file and sink kind. The
// comparison is bidirectional: a removed literal requires pruning its exception,
// so it cannot be silently reintroduced later.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = process.cwd();
const allowlistPath = join(root, 'scripts', 'i18n-copy-allowlist.json');
const sourceRoots = [
  'src/App.tsx',
  'src/components/ErrorBoundary.tsx',
  'src/features/monitor',
  'src/features/probe',
  'src/v2/collect',
  'src/v2/datasets',
  'src/v2/monitor',
  'src/v2/review',
  'src/v2/settings',
  'src/v2/shared',
  'src/v2/store',
  'src/v2/validation',
];
const attributeNames = new Set([
  'aria-label',
  'aria-description',
  'alt',
  'placeholder',
  'title',
]);
const dialogCalls = new Set(['alert', 'confirm', 'prompt']);

function copyViolations(observed, allowed) {
  const keys = new Set([...observed.keys(), ...Object.keys(allowed)]);
  return [...keys].sort().flatMap((key) => {
    const expected = allowed[key] ?? 0;
    const actual = observed.get(key) ?? 0;
    return expected === actual ? [] : [{ key, expected, actual }];
  });
}

function runSelfTest() {
  const violations = copyViolations(
    new Map([
      ['kept', 1],
      ['new-literal', 1],
    ]),
    { kept: 1, 'stale-exception': 1 },
  );
  assert.deepEqual(violations, [
    { key: 'new-literal', expected: 0, actual: 1 },
    { key: 'stale-exception', expected: 1, actual: 0 },
  ]);
  const source = ts.createSourceFile(
    'self-test.tsx',
    "window.confirm(`Remove ${name}` + ' now')",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let dialogArgument = null;
  const findDialog = (node) => {
    if (ts.isCallExpression(node)) dialogArgument ??= node.arguments[0] ?? null;
    ts.forEachChild(node, findDialog);
  };
  findDialog(source);
  assert.ok(dialogArgument);
  assert.equal(textOf(dialogArgument), 'Remove {{dynamic}} now');
  console.log('i18n copy guard self-test passed.');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

function filesIn(path) {
  const absolute = join(root, path);
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesIn(child);
    return entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      ? [join(root, child)]
      : [];
  });
}

function rawTextOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return `${node.head.text}${node.templateSpans
      .map(
        (span) => `${rawTextOf(span.expression) || '{{dynamic}}'}${span.literal.text}`,
      )
      .join('')}`;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return `${rawTextOf(node.left) || '{{dynamic}}'}${rawTextOf(node.right) || '{{dynamic}}'}`;
  if (ts.isJsxExpression(node) && node.expression) return rawTextOf(node.expression);
  return '';
}

function textOf(node) {
  return rawTextOf(node).trim();
}

function staticTextOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text.trim();
  if (ts.isJsxExpression(node) && node.expression) return staticTextOf(node.expression);
  return '';
}

function scanFile(file) {
  const sourceText = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings = [];
  const add = (kind, node, value) => {
    // Pure punctuation, separators, and icon glyphs are presentation syntax,
    // not operator copy. Letter/digit-bearing literals remain reviewable.
    if (!value || !/[A-Za-z0-9]/.test(value)) return;
    findings.push({
      key: `${relative(root, file)}|${kind}|${value}`,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add('jsx-text', node, node.getText(source).trim());
    if (
      ts.isJsxAttribute(node) &&
      attributeNames.has(node.name.text) &&
      node.initializer
    ) {
      add(`attr:${node.name.text}`, node, staticTextOf(node.initializer));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression, name } = node.expression;
      if (
        ts.isIdentifier(expression) &&
        expression.text === 'window' &&
        dialogCalls.has(name.text)
      ) {
        add(`window.${name.text}`, node, textOf(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const findings = sourceRoots.flatMap(filesIn).flatMap(scanFile);
const observed = new Map();
for (const finding of findings)
  observed.set(finding.key, (observed.get(finding.key) ?? 0) + 1);

if (process.argv.includes('--print-baseline')) {
  const entries = Object.fromEntries(
    [...observed.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  console.log(
    JSON.stringify(
      {
        purpose:
          'Reviewed literal display-copy baseline. Remove entries as a surface is localized; do not add new copy without a reasoned exception.',
        entries,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')).entries;
const violations = copyViolations(observed, allowlist);
if (violations.length) {
  console.error('Inline operator copy or its reviewed exception changed:');
  for (const violation of violations) {
    console.error(
      `  ${violation.key} (allowlist ${violation.expected}, found ${violation.actual})`,
    );
  }
  console.error(
    'Move display copy to src/i18n/locales, or add/prune a narrowly documented allowlist entry after review.',
  );
  process.exit(1);
}

console.log(
  `i18n copy guard passed (${findings.length} reviewed literal sinks across ${sourceRoots.length} scoped roots).`,
);
