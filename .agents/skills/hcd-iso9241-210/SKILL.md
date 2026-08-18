---
name: hcd-iso9241-210
description: Apply ISO 9241-210 human-centred design when fixing or designing UI — use this for any UI/UX fix, usability-finding remediation (e.g. from persona testing or heuristic review), or design review, to make sure a fix is traced to a real user/task, keeps system state visible, has a designed error/recovery path, and is evaluated against user-based evidence before it's called done, instead of being shipped on code-review judgment alone.
---

# Human-Centred Design for UI Fixes (ISO 9241-210 / ISO 9241-110)

ISO 9241-210 defines human-centred design (HCD) as an approach to interactive
systems that makes usability and user experience (UX) explicit design goals,
not side effects. Usability (ISO 9241-11) is "the extent to which specified
users can achieve specified goals with effectiveness, efficiency and
satisfaction in a specified context of use." UX is broader: a person's
perceptions and responses from using or anticipating use of the system —
their emotions, beliefs, and behaviour before, during, and after use, not
just task completion. A fix that closes a bug ticket but leaves the user
confused, anxious, or unable to recover has not met either bar.

## 1. The six HCD principles — checklist

For every UI change, walk this list. If you can't answer a "how to verify"
question, you don't have the ground truth to make the change yet.

| # | Principle | How to verify |
|---|-----------|----------------|
| a | Design is based on explicit understanding of users, tasks, and environments | Can you name the persona/user group, the task they're mid-way through, and the environment (device, urgency, distraction level) this fix serves? If not, you're guessing at a UI, not designing one. |
| b | Users are involved throughout | Is the evidence from representative participants (for example an actual test transcript or support report), or from a generated/stand-in persona? Label the latter as a hypothesis or expert aid, not user evidence. |
| c | Design is driven and refined by user-centred evaluation | What evidence comes from representative users, and what evidence is only an expert heuristic or persona walkthrough? Record the distinction instead of treating them as equivalent. |
| d | The process is iterative | Are you prepared to revise again if evaluation surfaces a new requirement, instead of treating the first patch as final? |
| e | Design addresses the whole user experience | Does the fix consider what happens immediately before and after this screen/state (what led here, what the user does next), not just the isolated widget? |
| f | Design team includes multidisciplinary skills and perspectives | For judgment calls on wording, safety-critical errors, or domain terms, did you pull in the relevant context (spec docs, prior UX findings, domain conventions) rather than a solo guess? |

## 2. Activity cycle, adapted to a code-fix workflow

ISO 9241-210 clause 6 defines four interlinked activities run as a loop:
understand context of use → specify user requirements → produce design
solutions → evaluate designs, repeating until no new requirements emerge.
For a UI fix, run the same loop compressed into four steps — do them in
order, and loop back a step if a later one invalidates an earlier answer:

1. **State the context of use and the affected persona.** One sentence:
   who hits this, doing what task, in what state (e.g. "an operator,
   mid-recording, glancing at the tab to confirm capture is still running").
2. **State the user requirement the fix serves.** Not "fix the bug" —
   the underlying need (e.g. "the operator must be able to tell, at a
   glance, whether recording is live or has silently died").
3. **Design against the dialogue principles** (section 3 below). Pick the
   principle(s) the finding violates and design the fix to satisfy them,
   not just to make the symptom disappear.
4. **Evaluate against the running UI before calling it done.** Re-run the
   original user scenario when representative-user evidence is available.
   Otherwise perform and label a heuristic/persona walkthrough using section 3;
   it is useful expert evidence, not a substitute for observed user evidence.

## 3. Dialogue-principles checklist (ISO 9241-110)

These operationalize "good UI" at the interaction level. Ask each question
of the specific screen/flow you touched:

- **Suitability for the task** — Does the UI expose exactly what this task
  needs, driven by the task's steps, not by what happened to be easy to
  implement?
- **Self-descriptiveness** — Can the user tell the system's current state
  at every moment, without training or asking someone? (Is anything
  happening that the UI doesn't say out loud?)
- **Conformity with user expectations** — Does behaviour match the
  conventions the user already knows (this app's own patterns, and common
  UI conventions), with consistent labels for the same concept everywhere?
- **Learnability** — Can a new user discover the functionality without a
  hidden gesture, undocumented shortcut, or config-file-only escape hatch?
- **Controllability** — Can the user pause, cancel, undo, or exit at every
  step, at their own pace, rather than the system's?
- **Use-error robustness** — Does a slip (misclick, wrong input, closed
  tab) cost data or leave unrecoverable state? Are errors explained in
  plain language with a way forward, not just a raised exception?
- **User engagement** — Is the UI honest and inviting — no fabricated
  numbers, no dead ends, nothing that motivates continued use by
  misrepresenting what's actually happening?

## 4. Fix-pattern table

Map the usability-finding type to the principle(s) it violates and the
required treatment. Use this to go from "what a persona test found" to
"what the fix must actually do" — not just suppress the symptom.

| Finding type | Principle(s) violated | Required treatment |
|---|---|---|
| State invisible (e.g. a process died silently, "zombie" state) | Self-descriptiveness | Add an explicit, live status indicator; the UI must never go quiet about a state transition the user needs to know about. |
| Mock/demo data mixed with or mislabeled as real | Self-descriptiveness, conformity with expectations | Visually distinct, persistent labeling of non-real data everywhere it appears; never silently substitute it for real data. |
| Missing save/action receipt | Self-descriptiveness, use-error robustness | Every state-changing action gets explicit success/failure feedback the user can see without guessing. |
| Mode confusion (unclear which mode/screen state is active) | Self-descriptiveness, conformity with expectations | Persistent, unambiguous mode indicator; controls behave consistently within each mode. |
| Irreversible action with no confirmation or undo | Controllability, use-error robustness | Confirm before, allow undo after, or at minimum state the consequence in the action's own label — pick one, never none. |
| Jargon / internal spec or codename leaking into UI copy | Suitability for the task, learnability | Replace with task-language the user's persona actually uses; internal terminology stays in docs, not in the UI. |
| Keyboard/focus loss on state change | Controllability | Preserve or deliberately re-target focus on every state change; the flow must be fully operable by keyboard. |
| Dead or fabricated affordance (button that does nothing, invented numbers) | Self-descriptiveness, use-error robustness, honesty | Wire it up or remove it; never render a control or a figure that doesn't reflect real, current system behaviour. |

## 5. Definition of done for a UI fix under this skill

A fix is not done when it compiles and looks right in the diff. It's done
when all of these are true:

- [ ] The requirement is traced to a named user/persona and a concrete task
      (section 2, step 1–2), not "seemed like a good idea."
- [ ] Current system state is visible to the user at all times relevant to
      this flow — no silent transitions the user must infer.
- [ ] The error/edge path is explicitly designed: a slip doesn't cost data,
      and recovery is possible without expert knowledge.
- [ ] The change has been checked against the section 3 dialogue-principles
      questions for the touched screen/flow.
- [ ] It has been evaluated against the running UI. Representative-user evidence,
      heuristic review, and persona walkthrough are labeled separately; none is
      presented as another kind of evidence.
- [ ] That evidence is recorded somewhere durable (commit message, PR
      description, or a dev_docs note): what was tested, what was observed.

If any box is unchecked, the fix addresses a symptom, not the usability
finding — loop back to step 1.
