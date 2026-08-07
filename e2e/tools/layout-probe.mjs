#!/usr/bin/env node
// Layout-resilience probe for Console v2 (E-25).
//
// Measures every tab at a fixed viewport and zoom for three things the console
// must never do, and prints one line per (tab x zoom):
//
//   1. the PAGE scrolls horizontally      — content wider than the window
//   2. Collect scrolls VERTICALLY         — Collect is a single-screen console;
//                                           a control below the fold during a
//                                           take is a control that is not there
//   3. text is cut with no mark           — an element whose content overflows
//                                           its box while nothing (an ellipsis,
//                                           a title tooltip) says so
//
// WHY THIS IS NOT A UNIT TEST. jsdom has no layout engine: every width, every
// scroll position and every overflow is 0 there, so a jsdom assertion about
// this would pass against any stylesheet at all. That is the campaign ruling
// (plan §533) and the reason this file exists outside the suite.
//
// WHY IT MEASURES RENDERED BOXES, NOT CLASS NAMES. The E-24 round found the
// trap: asserting on a `style` string or a `truncate` class tests the source,
// not the result — a `truncate` that cannot take effect because its parent is
// not a flex item still has the class. Everything below is read from
// getBoundingClientRect / scrollWidth / clientWidth on the LIVE element.
//
// SELF-TEST FIRST, AND PER KIND. `--self-test` plants one defect of each kind
// (over-wide, over-tall, unmarked clip) and requires the probe to report EACH
// KIND SEPARATELY. Counting "did any defect appear" is not enough and that is
// not hypothetical: a version of this probe that was blind to vertical scroll —
// the version that reported 12/12 clean while Collect scrolled 998px — passed
// an any-defect self-test on the strength of the horizontal one alone. A kind
// that is never detected has to fail the self-test by itself.
//
// THE VERTICAL CHECK IS COLLECT-ONLY, deliberately. The single-screen rule is a
// property of Collect (a control below the fold during a take is a control that
// is not there); Review, Datasets and Settings are lists and are SUPPOSED to
// scroll, so flagging them would be inventing a defect. The self-test therefore
// assesses the vertical kind only on Collect, and says so rather than passing
// quietly when Collect is not in the tab list.
//
// Usage (stack must be up: `make test-e2e-up`):
//   node e2e/tools/layout-probe.mjs --self-test
//   node e2e/tools/layout-probe.mjs
//   node e2e/tools/layout-probe.mjs --zoom 1.5 --tab collect --shots dev_image
//
// Exit code is 1 when any defect is found (or when the self-test fails to
// detect its own planted defects), so it can gate a manual round.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag('base', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18080');
const WIDTH = Number(flag('width', 1280));
const HEIGHT = Number(flag('height', 800));
const TABS = String(flag('tab', 'collect,review,datasets,validation,monitor,settings')).split(',');
const ZOOMS = has('zoom') ? [Number(flag('zoom'))] : [1, 1.5];
const SHOTS = flag('shots', null);
const SELF_TEST = has('self-test');

/**
 * The measurement, run inside the page.
 *
 * `deviceScaleFactor` cannot express browser zoom, and CSS `zoom` on <body>
 * does not move the layout viewport the way the browser's own zoom does. The
 * faithful way to get "the operator pressed Ctrl-+" is to shrink the viewport
 * by the zoom factor: at 150% on a 1280x800 monitor the page gets 853x533 CSS
 * pixels, and that is exactly what this measures.
 */
const MEASURE = () => {
  const doc = document.documentElement;
  const out = {
    pageScrollX: Math.max(0, doc.scrollWidth - doc.clientWidth),
    collectScrollY: 0,
    clipped: [],
  };

  // WHICH ELEMENT SCROLLS IS NOT FIXED, and assuming it is made this probe
  // report 12/12 clean while Collect scrolled 998px at 150% zoom. The
  // single-screen constraint (`lg:min-h-0 lg:flex-1 lg:overflow-auto`,
  // App.tsx:173) only applies at >=1024 CSS px; below that the DOCUMENT is the
  // scroller and the tabpanel reports 0. Take the worst of all three.
  const panel = document.querySelector('[role="tabpanel"]');
  out.collectScrollY = Math.max(
    0,
    doc.scrollHeight - doc.clientHeight,
    document.body.scrollHeight - document.body.clientHeight,
    panel ? panel.scrollHeight - panel.clientHeight : 0,
  );
  out.scrollerWhen = {
    doc: Math.max(0, doc.scrollHeight - doc.clientHeight),
    body: Math.max(0, document.body.scrollHeight - document.body.clientHeight),
    panel: panel ? Math.max(0, panel.scrollHeight - panel.clientHeight) : null,
  };

  // An element is "cut with no mark" when its content is wider than its box and
  // nothing tells the operator. `text-overflow: ellipsis` IS a mark (the
  // operator sees "…"), and a `title` is a mark (they can hover). A plain
  // `overflow: hidden` is not: the text simply stops.
  const isMarked = (el, cs) => {
    if (cs.textOverflow === 'ellipsis') return true;
    if (el.getAttribute('title')) return true;
    // A scrollable box is not a cut: the content is reachable.
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Only leaf-ish text holders: a container whose CHILD overflows is reported
    // on the child, and reporting both would bury the real site in ancestors.
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 1) continue;
    if (cs.overflow === 'visible' && cs.overflowX === 'visible') continue;
    if (isMarked(el, cs)) continue;
    const text = (el.textContent ?? '').trim().slice(0, 60);
    if (!text) continue;
    out.clipped.push({
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') ?? null,
      cls: (el.className ?? '').toString().slice(0, 70),
      overflowPx: overflow,
      text,
    });
  }
  return out;
};

/** Plant one defect of EACH KIND the probe claims to detect (self-test). */
const BREAK = () => {
  const wide = document.createElement('div');
  wide.style.cssText = 'width:4000px;height:8px;background:red';
  wide.setAttribute('data-selftest', 'page-scroll');
  document.body.appendChild(wide);

  const tall = document.createElement('div');
  tall.style.cssText = 'height:4000px;width:8px;background:red';
  tall.setAttribute('data-selftest', 'vertical-scroll');
  document.body.appendChild(tall);

  const cut = document.createElement('div');
  cut.setAttribute('data-testid', 'selftest-clipped');
  cut.style.cssText = 'width:40px;overflow:hidden;white-space:nowrap;font-size:12px';
  cut.textContent = 'a label far longer than forty pixels of box';
  document.body.appendChild(cut);
};

async function run() {
  const browser = await chromium.launch();
  const findings = [];
  if (SHOTS) mkdirSync(resolve(SHOTS), { recursive: true });

  for (const zoom of ZOOMS) {
    // Browser zoom shrinks the CSS viewport; see MEASURE's comment.
    const vw = Math.round(WIDTH / zoom);
    const vh = Math.round(HEIGHT / zoom);
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
    const page = await ctx.newPage();

    for (const tab of TABS) {
      await page.goto(`${BASE}/?tab=${tab}`, { waitUntil: 'networkidle' });
      // Let the first data land: an empty screen cannot overflow.
      await page.waitForTimeout(2500);
      if (SELF_TEST) await page.evaluate(BREAK);

      const m = await page.evaluate(MEASURE);
      const defects = [];
      const kinds = { horizontal: false, vertical: false, clipped: false };
      if (m.pageScrollX > 1) {
        kinds.horizontal = true;
        defects.push(`page scrolls horizontally by ${m.pageScrollX}px`);
      }
      if (tab === 'collect' && m.collectScrollY > 1) {
        kinds.vertical = true;
        defects.push(
          `Collect scrolls vertically by ${m.collectScrollY}px ` +
            `(doc ${m.scrollerWhen.doc} / body ${m.scrollerWhen.body} / panel ${m.scrollerWhen.panel})`,
        );
      }
      for (const c of m.clipped) {
        kinds.clipped = true;
        defects.push(
          `unmarked cut: ${c.testid ?? c.tag} overflows ${c.overflowPx}px — "${c.text}"`,
        );
      }

      const label = `${tab} @ ${zoom * 100}% (${vw}x${vh})`;
      if (defects.length === 0) {
        console.log(`ok    ${label}`);
      } else {
        console.log(`FAIL  ${label}`);
        for (const d of defects) console.log(`        ${d}`);
      }
      findings.push({ tab, zoom, defects, kinds });

      if (SHOTS) {
        await page.screenshot({
          path: resolve(SHOTS, `layout-${tab}-${zoom * 100}.png`),
          fullPage: false,
        });
      }
    }
    await ctx.close();
  }
  await browser.close();

  const bad = findings.filter((f) => f.defects.length > 0).length;
  if (SELF_TEST) {
    // Per KIND, not per page: "some defect showed up" is satisfied by a probe
    // that can only see one of the three.
    const collectRuns = findings.filter((f) => f.tab === 'collect');
    const sawHorizontal = findings.filter((f) => f.kinds.horizontal).length;
    const sawClipped = findings.filter((f) => f.kinds.clipped).length;
    const sawVertical = collectRuns.filter((f) => f.kinds.vertical).length;

    console.log('\nself-test, by kind:');
    console.log(`  horizontal: ${sawHorizontal}/${findings.length} pages`);
    console.log(`  clipped:    ${sawClipped}/${findings.length} pages`);
    console.log(
      `  vertical:   ${sawVertical}/${collectRuns.length} collect pages` +
        (collectRuns.length === 0 ? '  (NOT ASSESSED — no collect run)' : ''),
    );

    const failures = [];
    if (sawHorizontal < findings.length) failures.push('horizontal scroll');
    if (sawClipped < findings.length) failures.push('unmarked clipping');
    // Collect-only by design (see the header). Not assessable without a collect
    // run, and "not assessed" must not read as "passed".
    if (collectRuns.length === 0) {
      failures.push('vertical scroll (no collect page in --tab; cannot be assessed)');
    } else if (sawVertical < collectRuns.length) {
      failures.push('vertical scroll');
    }

    if (failures.length > 0) {
      console.log(
        '\nself-test FAILED — the probe is blind to: ' +
          failures.join(', ') +
          '\n  A clean run from this probe would not mean anything.',
      );
      process.exit(1);
    }
    console.log('\nself-test passed — all three kinds detected. A clean run means something.');
    process.exit(0);
  }
  console.log(`\n${findings.length - bad}/${findings.length} page-zoom combinations clean`);
  process.exit(bad > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
