---
name: robotics-software-principles
description: Apply modular software design, safety-aware interfaces, dependency inversion, timing separation, idempotency, observability, and graceful degradation to robotics modules. Use when designing or reviewing perception, planning, control, hardware adapters, robot libraries, configuration boundaries, command APIs, or robotics architecture; also use when refactoring robotics code or discussing SOLID and clean architecture for robots.
---

# Robotics software principles

Design robotics code around explicit contracts and failure states. A robot
combines asynchronous sensors, stateful hardware, timing constraints, and
physical risk; ordinary application patterns need safety and lifecycle details.

## Workflow

1. Identify the user-visible behavior and physical effect.
2. Separate pure decisions from I/O, transport, device SDKs, and clocks.
3. Define narrow interfaces with units, frames, timing, cancellation, and errors.
4. Choose safe defaults and specify behavior for invalid, missing, late, or
   duplicated input.
5. Test pure logic with fakes, then test adapters, integration, simulation, and
   hardware in proportion to risk.
6. Expose state transitions, timing, rejection reasons, and degradation through
   structured telemetry.

Read [references/patterns.md](references/patterns.md) when implementing hardware
adapters, command deduplication, configuration, timing boundaries, or degraded
operation.

## Design rules

### One responsibility per module

Keep acquisition, interpretation, planning, control, and hardware transport
separate. A camera driver should acquire frames; perception should interpret
them. A controller should not also discover devices or load UI configuration.

### Depend on capability interfaces

Make behavior depend on a small protocol such as `Arm`, `Clock`, or
`TransformProvider`, then inject the real, simulated, replay, or test adapter.
Do not leak a vendor SDK object through domain APIs.

Document non-obvious contract details:

- units and coordinate frames;
- synchronous versus asynchronous completion;
- deadlines, cancellation, and retry semantics;
- whether commands are absolute or relative;
- error categories and safe recovery paths.

### Extend by registration

Prefer a registry or plugin interface when adding sensors, validators, or
behaviors. Avoid growing a central `if device_type == ...` dispatcher. Reject
duplicate identifiers and validate plugin metadata at discovery time.

### Keep interfaces narrow and substitutable

Split read, move, stop, calibrate, and diagnose capabilities when consumers need
different subsets. A replacement implementation must preserve units, timing,
error semantics, and safety guarantees—not only method names.

### Separate rates and ownership

Do not make a fast control loop synchronously call slower perception, logging,
or network code. Give each rate domain one owner and communicate through bounded
queues, timestamped snapshots, or middleware. Define queue overflow policy and
staleness limits explicitly.

### Default to a safe state

- Keep actuators disabled until explicitly enabled.
- Clamp commands to configured limits after validating units and finiteness.
- Stop or hold safely on lost communication or stale input.
- Check workspace, collision, and lifecycle state before dispatch.
- Never use truthiness for numeric command values.

```python
def resolve_velocity(requested: float | None, maximum: float) -> float:
    velocity = maximum if requested is None else requested
    if not 0.0 <= velocity <= maximum:
        raise ValueError("velocity is outside the allowed range")
    return velocity
```

Here an explicit `0.0` remains zero; `requested or maximum` would silently turn
a stop-speed request into maximum speed.

### Externalize deployment values, not algorithms

Put addresses, topic names, frames, joint/workspace limits, thresholds, and
feature flags in validated configuration. Keep algorithms, error handling, and
data structures in code. Fail startup for unsafe or internally inconsistent
configuration instead of guessing.

### Make retries explicit

Prefer absolute commands when practical. For command IDs, record `running`,
`succeeded`, or `failed`; do not mark an ID complete before the physical action
finishes. A duplicate running request should return the existing status, while a
completed request should return the stored outcome. Define whether a failed ID
may be retried.

### Observe decisions and state

Emit structured events for command acceptance/rejection, lifecycle transitions,
input age, loop latency, queue depth, retries, degradation, and hardware faults.
Keep logs useful without placing unbounded formatting work in a real-time path.

### Compose and degrade deliberately

Build complex behaviors from small actions with explicit preconditions,
postconditions, cancellation, and rollback/safe-stop paths. Distinguish required
capabilities from optional enhancements. If an optional sensor fails, advertise
the degraded mode and tighten operating limits; never silently pretend full
capability.

## Review checklist

- [ ] Pure logic is separate from ROS/device/network I/O.
- [ ] Public interfaces specify units, frames, timing, and failure semantics.
- [ ] Hardware and simulation implement the same behavioral contract.
- [ ] Numeric zero, missing values, NaN/Inf, stale data, and duplicates are safe.
- [ ] Slow work cannot block a faster control path.
- [ ] Configuration is validated before enabling hardware.
- [ ] Command completion is recorded only after execution succeeds.
- [ ] Cancellation and communication loss lead to a defined safe state.
- [ ] Degraded capability is visible to operators and downstream modules.
- [ ] Tests cover decisions, adapters, integration, and relevant physical risk.
