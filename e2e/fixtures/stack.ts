// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Where the stack under test lives, and the few operations a scenario is
// allowed to perform ON it (as opposed to through it).
//
// The values are not duplicated here: `scripts/stack.sh env` prints them, and
// that script is the single definition of the ports, the data dir and the ROS
// domain. Re-declaring them in TypeScript is how an E2E suite ends up asserting
// against a stack that moved.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STACK_SH = resolve(HERE, '../scripts/stack.sh');

export interface StackEnv {
  /** The frontend the tests drive — the real nginx image, not a dev server. */
  baseUrl: string;
  /** `…/api/v1`. Used ONLY for secondary assertions and for setup. */
  apiUrl: string;
  orchUrl: string;
  /** Host path of the stack's data dir (objects/, lifecycle.jsonl, kairos.db). */
  dataDir: string;
}

let cached: StackEnv | undefined;

export function stackEnv(): StackEnv {
  if (cached) return cached;
  const out = execFileSync('bash', [STACK_SH, 'env'], { encoding: 'utf8' });
  const kv = new Map<string, string>();
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const need = (k: string): string => {
    const v = kv.get(k);
    if (!v) throw new Error(`stack.sh env did not report ${k}`);
    return v;
  };
  cached = {
    baseUrl: need('E2E_BASE_URL'),
    apiUrl: need('E2E_API_URL'),
    orchUrl: need('E2E_ORCH_URL'),
    dataDir: need('E2E_DATA_DIR'),
  };
  return cached;
}

/** Run a stack.sh subcommand, surfacing its output when it fails. */
export function stack(...args: string[]): string {
  try {
    return execFileSync('bash', [STACK_SH, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `stack.sh ${args.join(' ')} failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`,
    );
  }
}

/**
 * Assert the stack is up, or fail with the command that fixes it.
 *
 * A scenario that cannot run must FAIL, never skip: an acceptance suite whose
 * scenarios quietly evaporate when the environment is wrong reports green for
 * a branch nobody tested.
 */
export async function assertStackReachable(): Promise<void> {
  const { orchUrl, baseUrl } = stackEnv();
  const probes: [string, string][] = [
    ['orchestrator', `${orchUrl}/healthz`],
    ['frontend', `${baseUrl}/`],
  ];
  for (const [name, url] of probes) {
    let ok = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(
        `The E2E stack is not reachable: ${name} at ${url}.\n` +
          `Start it with:  make test-e2e   (or: bash ${STACK_SH} up)\n` +
          `This is a FAILURE, not a skip — the scenario was not verified.`,
      );
    }
  }
}
