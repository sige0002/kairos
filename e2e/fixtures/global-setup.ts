// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Refuse to run against a stack that is not there.
//
// Playwright's default when the app is missing is a wall of navigation
// timeouts; for an acceptance gate the first line of output should instead say
// what is wrong and how to fix it. The stack itself is started by `make
// test-e2e` (or by hand) rather than here, so a developer can bring it up once
// and iterate on the specs against the same store.

import { assertStackReachable, stackEnv } from './stack';

export default async function globalSetup(): Promise<void> {
  await assertStackReachable();
  const env = stackEnv();
  // eslint-disable-next-line no-console
  console.log(
    `\ne2e: driving ${env.baseUrl} (api ${env.apiUrl})\ne2e: store at ${env.dataDir}\n`,
  );
}
