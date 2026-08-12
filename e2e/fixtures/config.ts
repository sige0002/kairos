// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The committed config tree the stack runs on — the one thing this suite
// touches that lives OUTSIDE the per-run data dir.
//
// Every other fixture reads `e2e/.run/data`, which `stack.sh reset` wipes
// before each run, so a scenario can write there freely. `config/` is not that:
// compose mounts the repo's own `./config` into the orchestrator READ-WRITE
// (compose/compose.yaml — the Settings screen edits the active recording file
// through `PUT /api/v1/config/recording`), so a save driven from the browser
// rewrites a TRACKED file in the developer's working tree.
//
// That is a real product behaviour and the Settings scenario has to exercise
// it. What it must not do is leave the tree rewritten: the file is shared with
// the developer's own `make up` stack and with git. So the scenario reads the
// bytes first and puts them back in a `finally`.
//
// One nuance worth knowing before reading that scenario: the writer is
// `atomic_write_yaml(config.model_dump())`, which re-serialises the WHOLE
// validated model. A field left out of the file because its default is fine
// comes back materialised, so the round trip is faithful in meaning but not
// guaranteed byte-for-byte. "Unchanged" is therefore asserted against what the
// system reads (`GET /config/recording`), and the byte restore is housekeeping.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const repoConfig = {
  /** Where a `/config/...` path the API reports actually is on this host.
   *  Same translation `store.hostArchivePath` does for `/archive`. */
  hostPath(containerPath: string): string {
    if (!containerPath.startsWith('/config/')) {
      throw new Error(`not a path under the mounted config tree: ${containerPath}`);
    }
    return join(REPO_ROOT, containerPath.slice(1));
  },

  exists(containerPath: string): boolean {
    return existsSync(repoConfig.hostPath(containerPath));
  },

  read(containerPath: string): string {
    return readFileSync(repoConfig.hostPath(containerPath), 'utf8');
  },

  write(containerPath: string, text: string): void {
    writeFileSync(repoConfig.hostPath(containerPath), text, 'utf8');
  },
};
