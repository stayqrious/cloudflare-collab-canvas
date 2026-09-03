---
name: check-maths-steps
description: Watch or review a step-by-step maths solution in SpaceScale and respond to the first mistake with a probing or scaffolding question that helps the student repair their own reasoning without revealing the correction or final answer. Use when a teacher asks to check, monitor, watch, or coach selected maths steps on a live board.
---

# Check Maths Steps

Use SpaceScale's WebMCP watch and comment tools to give formative, one-step-at-a-time maths feedback. Preserve the student's method where it is mathematically viable.

## Start the watch

1. Confirm that the SpaceScale board and these site tools are available in the same agent session:
   - `watch_selected_problem_steps`
   - `comment_on_watched_step`
   - `inspect_selected_board_visual` when diagrams or handwriting matter
2. Treat the participant's current saved selection as the teacher-defined scope. Ask them to select the intended steps if the selection is empty or ambiguous.
3. When handwriting, a graph, or spatial notation is part of the reasoning, inspect that selected visual before assessing the corresponding saved text steps.
4. Call `watch_selected_problem_steps` with `action: start`.
5. Retain the returned watch token and next sequence. Continue with `action: wait` after every response and timeout until the watch ends or the teacher asks to stop.

## Check the mathematics

For every initial snapshot, saved change, or board-side Check my work request:

1. Infer the student's intended method from the visible preceding steps.
2. Verify the steps in order. Check arithmetic, signs, algebraic equivalence, substitutions, distribution, factorization, cancellation conditions, domains, units, diagram consistency, and any stated assumptions that matter.
3. Locate the earliest step that is incorrect or unsupported. Treat later consequences as downstream effects, not separate mistakes.
4. Distinguish an actual error from an alternative valid method.
5. If handwriting or intent is unclear, ask the student to clarify the ambiguous mark instead of guessing.
6. If every visible step is valid, acknowledge the specific reasoning that works and ask what the student plans to try next. Do not invent a mistake.

## Scaffold without giving away the answer

Respond to only the first mistake. Do not provide the corrected step, missing value, factorization, root, proof, or final answer.

Use the lightest prompt likely to move the student forward:

1. **Notice:** Ask the student to re-check the exact operation or compare two expressions.
2. **Recall:** Ask which definition, identity, inverse operation, sign rule, or diagram property applies.
3. **Test:** Suggest a value, boundary case, estimate, or substitution and ask the student to compute or interpret the result.
4. **Reduce:** Offer a simpler analogous expression and ask what pattern it reveals.
5. **Structure:** Provide a partial setup with a blank, but leave the decisive computation to the student.

If the next saved attempt still contains the same misconception, move down one level in this ladder. Never jump directly to the answer.

Make every prompt:

- specific to the watched step;
- answerable with one concrete action;
- short enough to act on immediately;
- neutral and respectful;
- free of grades, scores, ability labels, or claims about the student.

## Reply on the board

Prefer `comment_on_watched_step` with `action: check_work`. Keep one comment focused on one watched step and use this shape:

```text
What is working: <one precise observation, when applicable>
Revisit: <the operation, representation, or assumption—not its correction>
Question: <one probing or scaffolding question>
```

For the example `x² + 7x + 10 = 0` with an inconsistent graph, ask something such as:

> If you substitute x = -4 into the expression, what value do you get, and should your curve pass through that point?

Do not include the computed value or the corrected graph.

Use a source-linked board card only when the teacher asks for a durable exercise, worked analogue, or extension. Keep the decisive step blank. Default to a comment so feedback remains attached to the student's work.

## Continue or stop

- On `changed` or `requested`, check the affected step, reply once, then wait again with the returned sequence.
- On `timeout`, wait again without adding content.
- On `resync`, reassess the fresh snapshot before continuing.
- On `stopped`, `expired`, or `replaced`, end the loop and report why.
- Stop immediately when the teacher asks. Do not start a replacement watch unless requested.
