#!/usr/bin/env node
// Headless UI verification for kairos console v2 screens (Playwright/chromium).
// See ../v2-screen-work/SKILL.md for the workflow this supports.
//
// Usage:
//   node ui-check.mjs --port 5183 --tab review --shot ../../dev_image/review-default.png \
//     [--assert '<css-selector>']... [--click '<css-selector>']... \
//     [--full-flow <path-to-module.mjs>] [--no-scroll]
//
// Run with cwd = e2e (or any package that has playwright in its own
// node_modules) — the script lives under .agents/skills/, outside that
// tree, so it resolves the "playwright" package relative to process.cwd()
// via createRequire rather than its own file location.
//
// --click and --assert may repeat; clicks run first, in the order given, then
// all asserts are checked (missing ones are collected and reported together,
// not failed on the first miss). --full-flow runs before --click/--assert,
// for interactions too complex for a flat click/assert list (its module must
// export `async function run(page)`).

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(path.join(process.cwd(), 'noop.cjs'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error(
    `Could not load the "playwright" package from ${process.cwd()}/node_modules.\n` +
      `Run this script with cwd set to a package that has it installed (e.g. e2e).\n` +
      `Original error: ${e.message}`,
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    port: null,
    tab: null,
    shot: null,
    asserts: [],
    clicks: [],
    fullFlow: null,
    noScroll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port':
        args.port = argv[++i];
        break;
      case '--tab':
        args.tab = argv[++i];
        break;
      case '--shot':
        args.shot = argv[++i];
        break;
      case '--assert':
        args.asserts.push(argv[++i]);
        break;
      case '--click':
        args.clicks.push(argv[++i]);
        break;
      case '--full-flow':
        args.fullFlow = argv[++i];
        break;
      case '--no-scroll':
        args.noScroll = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  if (!args.port || !args.tab) {
    console.error(
      'Usage: node ui-check.mjs --port <n> --tab <id> [--shot <path>] ' +
        "[--assert '<sel>']... [--click '<sel>']... [--full-flow <module.mjs>] [--no-scroll]",
    );
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = `http://localhost:${args.port}/?tab=${args.tab}`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  let exitCode = 0;
  try {
    // 'load' rather than 'networkidle': the app opens a long-lived SSE
    // connection (useEventStream) that never goes idle and would stall
    // networkidle until timeout. The real readiness gate is the tabpanel
    // selector below.
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector(`#panel-${args.tab}`, { timeout: 10000 });

    if (args.fullFlow) {
      const modPath = path.resolve(args.fullFlow);
      const mod = await import(`file://${modPath}`);
      if (typeof mod.run !== 'function') {
        throw new Error(`--full-flow module ${args.fullFlow} does not export an async run(page)`);
      }
      await mod.run(page);
    }

    for (const sel of args.clicks) {
      await page.click(sel, { timeout: 10000 });
    }

    const missing = [];
    for (const sel of args.asserts) {
      const count = await page.locator(sel).count();
      if (count === 0) missing.push(sel);
    }
    if (missing.length > 0) {
      console.error(`FAIL — missing selector(s):\n${missing.map((s) => `  - ${s}`).join('\n')}`);
      exitCode = 1;
    }

    const hasScroll = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
    );
    if (hasScroll) {
      const msg = `page has vertical scroll (scrollHeight > clientHeight) on tab=${args.tab}`;
      if (args.noScroll) {
        console.error(`FAIL — ${msg}`);
        exitCode = 1;
      } else {
        console.warn(`WARN — ${msg}`);
      }
    }

    if (args.shot) {
      fs.mkdirSync(path.dirname(args.shot), { recursive: true });
      await page.screenshot({ path: args.shot });
      console.log(`Screenshot saved: ${args.shot}`);
    }

    if (consoleErrors.length > 0) {
      console.warn(
        `WARN — ${consoleErrors.length} browser console error(s):\n` +
          consoleErrors
            .slice(0, 5)
            .map((e) => `  - ${e}`)
            .join('\n'),
      );
    }

    if (exitCode === 0) console.log(`PASS — tab=${args.tab} port=${args.port}`);
  } catch (e) {
    console.error(`FAIL — ${e.message}`);
    exitCode = 1;
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
}

main();
