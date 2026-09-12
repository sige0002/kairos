---
name: frontend-design
description: Choose a coherent visual direction for a new frontend or an explicitly requested redesign. Preserve the existing visual system for focused feature work.
---

# Frontend design

For an established product, use its tokens, typography, components, and
interaction language. Open new visual directions only where the brief asks for
them. In kairos Console v2, use `v2-screen-work` for the product's reuse and
acceptance requirements.

## Develop the requested direction

Ground visual choices in the actual subject, audience, content, and page task.
If an unspecified detail is easy to infer, state the assumption and proceed;
do not invent client history or treat a generic style preference as a mandate.

Choose typography, color, layout, and any signature element as a coherent whole.
Use a compact token plan or wireframe when it resolves meaningful design
choices. A focused fix does not require new palettes, multiple font families,
a hero, or a separate design-plan phase.

Structural devices should communicate real relationships: numbering for an
actual sequence, labels for meaningful categories, and emphasis for the next
useful action. Match visual complexity to the content and brief. Motion should
explain state or support the chosen direction without obscuring controls.

## Copy and implementation

Use terms people recognize from their task. Name actions by their outcome and
keep that vocabulary consistent across buttons, status, receipts, and errors.
Empty states explain why content is absent and what the user can do next.
Errors identify the problem and a recovery path. Do not expose internal
implementation terms unless they help the product's user make a decision.

Inspect the rendered result when available: hierarchy, text wrapping, responsive
behavior, keyboard focus, reduced motion, and changed states. Watch for CSS
specificity conflicts and decoration that competes with content. Use evidence
from this result to refine the design; do not require a fixed number of design
passes or claim uniqueness without a concrete basis.
