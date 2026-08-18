# Property, regression, and simulation tests

## Contents

- Pure and property-based tests
- Read-only golden files
- Explicit golden updates
- Simulation and safety assertions

## Pure and property-based tests

Keep geometry, parsing, planning primitives, and state transitions outside ROS nodes where possible.

```python
import numpy as np
from hypothesis import given, strategies as st
import hypothesis.extra.numpy as hnp


@given(
    start=hnp.arrays(
        np.float64,
        (7,),
        elements=st.floats(-3.14, 3.14, allow_nan=False, allow_infinity=False),
    ),
    end=hnp.arrays(
        np.float64,
        (7,),
        elements=st.floats(-3.14, 3.14, allow_nan=False, allow_infinity=False),
    ),
    steps=st.integers(min_value=2, max_value=1000),
)
def test_linear_interpolation_invariants(start, end, steps):
    trajectory = linear_interpolate(start, end, steps)
    assert len(trajectory) == steps
    np.testing.assert_allclose(trajectory[0], start)
    np.testing.assert_allclose(trajectory[-1], end)
    distances = np.linalg.norm(trajectory - end, axis=1)
    assert np.all(np.diff(distances) <= 1e-10)
```

Exclude NaN and infinity unless the test specifically checks their rejection. Test coordinate frames, units, joint limits, and normalization explicitly.

## Read-only golden files

A test compares against a reviewed artifact and fails if that artifact is absent. It never creates a baseline as a side effect.

```python
from pathlib import Path

import numpy as np


GOLDEN_DIR = Path(__file__).parent / "golden_trajectories"


def test_straight_line_plan():
    trajectory = planner.plan(
        np.array([0.3, 0.0, 0.5]),
        np.array([0.5, 0.2, 0.3]),
    )
    golden_path = GOLDEN_DIR / "straight_line.npy"
    assert golden_path.is_file(), (
        "missing reviewed golden; run the repository's explicit golden-update "
        "tool, review its diff, and rerun tests"
    )
    expected = np.load(golden_path, allow_pickle=False)
    np.testing.assert_allclose(trajectory, expected, atol=1e-4)
```

Do not implement `if not path.exists(): save(); skip()`. That turns a missing oracle into a passing run and lets CI bless the output under test.

## Explicit golden updates

Put updates in a separate command such as `python tools/update_trajectory_goldens.py`. The updater should:

1. Refuse a dirty or unexpected input state when reproducibility depends on it.
2. Fix seeds, configuration, model/version, units, and coordinate frames.
3. Write to a temporary file and atomically replace the selected golden.
4. Print every changed path and the command needed to rerun its tests.
5. Require human review of the binary/text diff or a rendered diagnostic.

An opt-in pytest flag is acceptable only when it is disabled by default, clearly named (for example `--update-goldens`), and cannot run accidentally in CI. Keep generation logic outside the assertion path.

## Simulation and safety assertions

Seed the simulator and step it explicitly:

```python
def test_pick_and_place(simulator):
    simulator.reset(seed=42)
    simulator.spawn_object("block", pose=[0.4, 0.1, 0.02])
    behavior = create_pick_place_behavior(simulator)

    for step in range(1000):
        behavior.tick()
        simulator.step()
        assert not simulator.robot_has_forbidden_contact()
        if behavior.succeeded:
            break
    else:
        raise AssertionError(f"task did not finish; state={behavior.state}")

    actual = simulator.get_object_pose("block")
    expected = np.array([0.5, -0.1, 0.02])
    assert np.linalg.norm(actual[:3] - expected) < 0.02
```

Assert both outcome and invariants such as no forbidden contact, bounded velocity/acceleration, watchdog response, workspace limits, and a safe terminal state. A simulator may validate application logic but does not prove the physical driver, timing, or emergency-stop chain.
