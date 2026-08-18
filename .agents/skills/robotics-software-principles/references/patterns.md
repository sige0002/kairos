# Robotics design patterns

Read the section that matches the current design task.

## Contents

- Hardware capability interfaces
- Timing boundaries
- Safe command deduplication
- Validated configuration
- Graceful degradation

## Hardware capability interfaces

Expose the smallest contract the behavior needs. Keep device discovery and SDK
objects inside the adapter.

```python
from typing import Protocol


class Arm(Protocol):
    @property
    def joint_count(self) -> int: ...

    def joint_positions_rad(self) -> tuple[float, ...]: ...

    def move_joints(
        self,
        positions_rad: tuple[float, ...],
        *,
        max_velocity_rad_s: float,
        command_id: str,
    ) -> None: ...

    def stop(self) -> None: ...
```

Validate vector length, finiteness, limits, and lifecycle state in a shared
boundary before calling either the real or simulated adapter. Tests should run
the same contract suite against both implementations.

## Timing boundaries

Use a bounded buffer between unequal rate domains. The producer should attach a
monotonic timestamp; the consumer rejects stale data and records drops.

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Observation:
    captured_monotonic_s: float
    value: object
```

Choose overflow behavior from the task:

- control/status snapshots usually keep the latest value;
- lossless recording applies backpressure or fails visibly;
- ordered commands reject overflow rather than dropping silently.

Never hide queue growth behind an unbounded queue.

## Safe command deduplication

Track execution separately from receipt. Persist the state before dispatch when
crash recovery matters, but mark success only after the adapter confirms
completion.

```python
def execute_once(command, store, adapter):
    prior = store.get(command.id)
    if prior and prior.state in {"running", "succeeded"}:
        return prior

    store.mark_running(command.id)
    try:
        result = adapter.execute(command)
    except Exception as exc:
        store.mark_failed(command.id, str(exc))
        raise
    store.mark_succeeded(command.id, result)
    return store.get(command.id)
```

This prevents the unsafe sequence “remember ID, dispatch, crash,” which can
misreport an unexecuted command as complete. For physical commands that cannot
be queried after a crash, define an `unknown` state and require reconciliation
instead of automatically retrying.

## Validated configuration

Validate at startup:

- lower limits are below upper limits;
- defaults fall within limits;
- frame and topic identifiers are non-empty;
- timeouts and rates are positive;
- safety features cannot be disabled accidentally in hardware mode.

Keep conservative defaults in a typed schema. Treat missing deployment-specific
values as a startup error when guessing could move hardware or corrupt data.

## Graceful degradation

Define capability states such as `ready`, `degraded`, `blocked`, and `faulted`.
For each optional dependency, specify:

1. how failure is detected and debounced;
2. what behavior remains available;
3. which limits become stricter;
4. what operator and downstream consumers see;
5. how recovery is verified before returning to `ready`.

Do not catch an exception and continue with stale data under a healthy status.
