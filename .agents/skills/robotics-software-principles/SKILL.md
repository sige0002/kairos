---
name: robotics-software-principles
description: Design or review robotics interfaces where timing, physical effects, cancellation, hardware substitution, and recovery shape the architecture.
---

# Robotics interfaces and failure states

Use explicit contracts for units, coordinate frames, input age, deadlines,
cancellation, errors, and physical completion. Separate pure decisions from
ROS/device/network I/O, vendor SDKs, and clocks where it makes those contracts
testable. Avoid adding layers solely to satisfy an architecture pattern.

Read [patterns.md](references/patterns.md) when implementing hardware adapters,
command deduplication, configuration, timing boundaries, or degraded operation.

## Invariants that matter for robots

- A fake, simulator, or alternate device adapter preserves units, timing, error,
  and safety behavior, not just method names.
- Fast control paths must not block on slow perception, logging, or networking.
  Assign ownership and bound queues; define overflow and stale-data behavior.
- Validate finite numeric values, units, limits, and state before dispatch.
  Treat explicit zero separately from missing values: `requested or maximum`
  can turn a zero-speed request into motion.
- Keep actuators disabled until enabled. Communication loss, cancellation, and
  invalid/stale inputs lead to a defined safe stop or hold.
- Command deduplication records running/succeeded/failed accurately. Do not mark
  a command complete before physical execution finishes. Define retry behavior
  for failed IDs and whether commands are absolute or relative.
- Validate deployment configuration before enabling hardware. Put addresses,
  topics, frames, thresholds, and limits in configuration; keep algorithms and
  error handling in code.
- Report rejected commands, input age, timing, state transitions, and degraded
  capabilities. Optional sensor failure must not silently imply full capability.

Test the contract at the lowest layer that can observe it, adding integration,
simulation, or authorized hardware evidence for risks those tests cannot cover.
A simulation pass does not prove real hardware safety.
