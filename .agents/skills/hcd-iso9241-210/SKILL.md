---
name: hcd-iso9241-210
description: Evaluate usability findings and design user-task flows using human-centred design principles. Use for usability design, research, or review; cosmetic edits do not need a research cycle.
---

# Human-centred UI design

Connect the change to a user, task, and context of use. Distinguish the
underlying need from the reported symptom: for example, a recording indicator
helps an operator know whether a capture remains live.

Use the depth of evaluation the task warrants. A support report, existing
scenario, or specified operator workflow can support a focused repair without
inventing a new persona study. Where context is missing, identify the assumption
and any user research needed to resolve it; do not present assumptions as facts.

## Design and evaluate the affected flow

Consider the state before the action, the result, and the recovery path:

| Finding | Relevant treatment |
|---|---|
| Invisible state or missing receipt | Show live state and an observable action outcome |
| Mock data shown as real | Persistently distinguish simulated or unavailable data |
| Mode confusion or jargon | Use task vocabulary and a clear current-mode indicator |
| Irreversible action | Make the consequence explicit and provide suitable confirmation or recovery |
| Lost keyboard focus | Preserve or deliberately move focus to keep the task operable |
| Dead affordance | Implement its outcome, or remove/disable it with an honest explanation |

Assess whether users can discover the action, understand the current state,
control its pace, avoid or recover from errors, and verify the result. Preserve
the product's established terms and conventions. For kairos UI changes, the
running-screen and E2E requirements live in `v2-screen-work`.

## Label the evidence

Representative-user observations, expert heuristic review, generated persona
walkthroughs, and automated acceptance tests answer different questions.
Record which was actually performed; a generated persona is a hypothesis or
expert aid, not observed user evidence. A passing test is evidence only for the
scenario and state it exercises, not proof of satisfaction or ISO compliance.

Revisit the design when evaluation reveals a concrete unmet requirement.
Report the user requirement, observed result, and remaining uncertainty in the
existing task handoff or requested review artifact. Do not create research
reports or repeat the entire activity cycle for every cosmetic change.
