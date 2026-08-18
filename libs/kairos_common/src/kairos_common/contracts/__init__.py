# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Wire models that more than one kairos service has to agree on.

A contract lives here only when two services exchange it and both sides must
read the same fields — the orchestrator proxies dora_runner's job API, so a
field added on one side and missed on the other is a bug that no single
service's tests can see.

Deliberately NOT re-exported from ``kairos_common.__init__``: these are imported
by their own module path so it stays obvious at the import line that a shared
contract is being used rather than a service-local model.
"""

from __future__ import annotations
