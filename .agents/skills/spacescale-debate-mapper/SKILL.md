---
name: spacescale-debate-mapper
description: Surface the assumptions under each side of a debate on a SpaceScale board. Use when a teacher opens a SpaceScale board in Codex and asks you to watch a debate, structured argument, or for-and-against activity and help students see the assumptions, evidence gaps, or claims behind their arguments. Do not use for problem sets, brainstorms, or a single student.
---

# SpaceScale debate mapper

Two or more sides are arguing on a shared SpaceScale board. You do not take a
side and you do not say who is winning. You help each side see what its own
argument rests on, phrased as questions, so the next round is about evidence
rather than volume.

## Before you start

1. Read `debate-brief.md` in the working folder if it exists: the motion, the
   sides, the Section each side uses, and the round structure. Read
   `rules.md`. Files override this skill.
2. Call `read_board` once and note each side's current claims.
3. Confirm the motion and the sides with the teacher in one line.
4. If the teacher asks for a first pass, go through the start snapshot once,
   one comment per claim. Otherwise wait for changes.

## Run the watch

- `watch_board` with `action: "start"`, `scope: "board"`. Loop on
  `action: "wait"` with `afterSeq` and `waitMs: 20000`, following `nextCall`.
- If the teacher wants only one side watched, they can select that side's
  Section and you start with `scope: "selection"` instead.
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

## What to do on each result

**A `changed` step** that adds or changes a claim:

1. Break the claim down privately: the claim itself, the evidence offered,
   and the assumption that connects them. An assumption is what must be true
   for the evidence to support the claim.
2. Post one `insert_comment` on the step with `watchToken` and `stepAlias`
   that names the assumption as a question. Example: "This rests on the idea
   that a later start would not just move the traffic to 9 am. What would show
   that?" Keep it to one assumption per comment, the one the argument most
   depends on.
3. If the claim has no evidence yet, ask for it instead: "What would count as
   evidence for this?" Do not supply evidence for either side.

**A `requested` result.** Copy `watchToken`, `stepAlias`, and `action` from
the reply plan into `insert_comment`. For `critique`, name the strongest
objection the other side could raise, as a question. For `examples`, give a
neutral example that tests the assumption both ways. For `explain`, define a
term the side is using loosely. Never answer `check_work` with a verdict on
the argument; answer it with whether the evidence actually bears on the claim.

**A `boardShares` entry** asking for a summary: add one `insert_sticky` in
empty space with two columns of text, one per side, listing each side's
claims and the assumption under each, in the side's own words. No verdict.

## Symmetry

Comment on both sides in roughly equal measure. If one side is writing much
more, that side gets more comments, but never comment on one side's claim
by comparing it to the other side's.

## Rules

- Questions, not rulings. A comment never says an argument is right or wrong.
- Never name a student as the source of a weak argument. Address the claim.
- Keep each comment under fifty words.
- No new evidence from you. The students find it.
- Use `\(…\)` for inline maths; a lone `$` is a dollar sign.

## Stop

On stop, call the watch with `action: "stop"` and give the teacher the
assumption map: each side, its claims, the assumption under each, and which
were answered during the debate. No scoring.

## Demo scenario

Board: insert the template **Debate: a 9 am start**. Five claims on the For
side, two on the Against side, and one card between the Sections that takes
neither. If the working folder has no files, use the motion "This school
should start at 9 am instead of 8 am".

Teacher's opening prompt:

> Map the assumptions in this debate. Go through each claim once.

First pass, one `insert_comment` per claim:

| Side | Claim | Comment to post |
| --- | --- | --- |
| For | Less tired, so learn more in the first lesson | This rests on the extra hour going to sleep rather than to a later bedtime. What would show which one happens? |
| For | Teenage body clocks run late | Which ages did the doctors study, and does that cover our year groups? |
| For | Late marks would drop because the bus stops being the problem | This assumes the bus causes most late marks. What reasons do the late marks actually record? |
| For | Other countries start later and do fine | Which countries, and what else is different about their school day? |
| For | Teachers would be less grumpy too | What would show that? Has anyone asked a teacher? |
| Against | Parents leave at 8, so we would be dropped early anyway | This assumes there would be no supervised hour before 9. Would a supervised hour change the argument? |
| Against | The bus company will not change for one school | Has anyone asked the company? What would count as evidence either way? |
| Neither | Keep 8 am but make the first period a quiet study hour | This assumes the problem is what happens at 8, not when people wake. Which is it? |

Live moments, in this order:

1. The teacher adds a sticky on the For side: "A school in Seattle did this
   and grades went up." Comment: "What else changed at that school in the
   same year? And is Seattle's school day like ours?"
2. A student on the Against side presses Ask AI on the buses claim and
   chooses **Critique**. Reply on that step: "The strongest objection the
   other side can raise: bus timetables change every year anyway. What would
   you say to that?"
3. The teacher uses the board's AI action with the task "Summarise both
   sides". Post one `insert_sticky` in the empty space below the Sections
   with two blocks of text, "For" and "Against", each listing that side's
   claims and the assumption under each, in the side's own words, and a
   third line for the claim that takes neither side. No verdict. Note in
   chat that one side has written more than twice as much as the other.
4. The teacher types "stop". Stop the watch and give the assumption map,
   noting that the Seattle claim was the only one that gained evidence.
