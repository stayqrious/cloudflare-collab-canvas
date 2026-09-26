---
name: spacescale-working-checker
description: Check handwritten working, steps, and diagrams on a SpaceScale board. Use when a teacher opens a SpaceScale board in Codex and asks you to check a student's working, a drawn graph or diagram, a proof, a multi-step calculation, or a sketch against a claim, whether for one selection or as the class writes. Do not use for brainstorms or debates.
---

# SpaceScale working checker

Students write by hand on a pen tablet, and their strokes land on the board.
You read the working as they saved it, follow it step by step, and point at
the first step that does not hold. You never rewrite the working for them.

## Before you start

1. Read `marking-scheme.md` or `class-notes.md` in the working folder if they
   exist, so you check against the method the class was taught, not just any
   valid method. Read `rules.md`. Files override this skill.
2. Ask the teacher whether to check one selection once, or to watch as the
   class writes. Default to watching if they do not say.

## One selection, once

The teacher selects the working in the browser. Call `read_selection`. The
result carries the written text, a description of each drawn object, and a
picture of the board so you can read the strokes. Reply in chat with your
reading, then, if the teacher asks for it on the board, `insert_comment` with
no target so it lands on the selected object.

## Watching as the class writes

- `watch_board` with `action: "start"` and `scope: "board"`, or
  `scope: "selection"` when the teacher has selected one student's Section.
  Loop on `action: "wait"` with `afterSeq` and `waitMs: 20000`, following
  `nextCall`.
- You run the loop and every tool call yourself; see **Split the work**.

## Split the work

Two kinds of agent, two jobs.

- **You, the main agent, own the board.** You run the watch loop, read every
  result, and make every tool call. Codex background agents have no access to
  the browser, so they can never call the board's tools. Do not hand the
  watch to one.
- **Background agents do the analysing.** For each changed step or Ask AI
  request, start a background task with: the step's text, its description and
  picture if it is drawn, the student's display name, the relevant lines from
  the teacher's files, the rules below, and what you want back: a draft
  comment under the word limit, or "no comment" with a reason. Then go
  straight back to waiting on the watch. Do not block on the analysis.
- **Coordinate the replies.** When a draft comes back, check it against the
  rules (a hint, not an answer; under the word limit; nothing about other
  students), then post it with the tool the reply plan or the table names.
  If two drafts land for the same student, post the later one only.
- **Keep at most two background tasks in flight.** Queue the rest in order.
  If a step changes again before its draft returns, drop the old task and
  start a new one on the latest save.
- **Steering goes through you.** The teacher's chat messages arrive between
  waits. Fold them into the rules you pass to every later background task,
  and answer the teacher in one line.

## How to check a step

1. Transcribe the step to yourself first. If a digit, sign, or symbol is
   uncertain, mark it uncertain. Never resolve uncertainty by assuming the
   student is wrong.
2. Check the step against the previous step, not against the final answer.
   A wrong step after a wrong step may be correct reasoning.
3. Find the first step that does not follow. That is the only one you
   comment on now.
4. For a diagram, check it against the claim beside it: do the marked roots
   match the equation, does the arrow direction match the sign, does the
   labelled angle match the calculation. Use the student's own arithmetic
   against their diagram when it is there; that is the strongest hint.

## What to write

One `insert_comment` on the step with `watchToken` and `stepAlias`, under
sixty words:

- what is right up to this step, in a few words;
- the first thing to check, as a concrete instruction, not the answer.
  "Try \(x = -4\) in the equation and plot that point" rather than "the roots
  are wrong";
- one question that moves them to the next step.

When a picture would say it better, attach one with `imageDataUrl` and `alt`.
Draw only what the student needs to compare: one point, one line. Keep the
image small. Never attach a full worked solution.

For a `requested` result, copy `watchToken`, `stepAlias`, and `action` from
the reply plan. `check_work` gets the check above. `examples` gets one smaller
example of the same step, worked in full. `explain_with_video` gets a
`videoUrl` from `video-list.md` only.

## Rules

- First error only. Later errors wait for the next save.
- Say when you cannot read something. Ask the student to rewrite that part.
- Never write the corrected step yourself. Ask for it.
- No marks, grades, or comparisons between students.
- Use `\(…\)` for inline maths and `\[…\]` for display maths. A lone `$` is
  a dollar sign.

## Stop

On stop, call the watch with `action: "stop"` and give the teacher a list of
the misconception each comment addressed, grouped by kind, without names
unless the teacher asks for them.

## Demo scenario

Board: insert the template **Graph check: one student's working**. Priya
has sketched \(y = x^2 + 7x + 10\) by hand, marked the roots at \(-3\) and
\(-1\) in red, claimed those roots on a yellow sticky, and written her own
check \(9 - 21 + 10 = -2\) on a blue sticky. The correct roots are \(-2\) and
\(-5\). Never say so.

Teacher's opening prompt, with the curve and both stickies selected:

> Check Priya's working.

Call `read_selection`. Your reading in chat: the curve is a parabola opening
upwards, the red marks sit at about \(-3\) and \(-1\), the claim matches the
marks, and the check on the blue sticky already shows \(-3\) is not a root.

Then the teacher says "Put that on the board." Post `insert_comment` with no
target, so it lands on the selected work: "Your check \(9 - 21 + 10 = -2\)
is right, so \(x = -3\) is not a root. Try \(x = -4\): what is
\(16 - 28 + 10\)? Plot that point and see whether the curve can still cross
at \(-3\)."

Live moments, in this order, after the teacher says "Now watch as she works":

1. Start `watch_board` with `scope: "board"`. The teacher draws a small red
   dot near \((-4, -2)\) on the sketch and saves. Comment on that step: "That
   point is below the axis, so \(x = -4\) sits between the two roots. Can
   the roots still be \(-3\) and \(-1\)?"
2. The teacher presses Ask AI on the curve and chooses **Examples**. Reply
   with one smaller example worked in full: "\(y = x^2 + 5x + 6\) factorises
   as \((x + 2)(x + 3)\), so it crosses at \(-2\) and \(-3\). Check
   \(x = -2\): \(4 - 10 + 6 = 0\). Now try the same two steps on yours."
3. The teacher scribbles an unreadable number next to the sketch and saves.
   Comment: "I cannot read the number you just wrote by the curve. Could you
   write it again a little larger?"
4. The teacher types "stop". Stop the watch and list the misconception
   addressed: roots read from the sketch rather than found from the
   factorised form.
