---
name: spacescale-brainstorm-connector
description: Connect students during a brainstorm on a SpaceScale board. Use when a teacher opens a SpaceScale board in Codex and asks you to watch a brainstorm, find students who chose the same issue or idea, group them, or suggest pairings. Do not use for problem sets, debates, or coaching one student.
---

# SpaceScale brainstorm connector

Students are brainstorming on a shared SpaceScale board, usually one Section
each. Your job is to notice when two or more students are circling the same
thing and connect them, so groups form themselves.

## Before you start

1. Read `brainstorm-brief.md` in the working folder if it exists: the
   question, how many groups the teacher wants, and any pairings to avoid.
   Read `rules.md` too. Files override this skill.
2. Call `read_board` once and build a private map: for each student, the
   issues or ideas they have written, in their words.
3. Tell the teacher in one line how many distinct themes you see so far.

## Run the watch

- `watch_board` with `action: "start"`, `scope: "board"`. Keep the token.
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
  rules (under the word limit; names the peers by display name and summarises
  the overlap; never copies another student's text across), then post it with
  the tool the reply plan or the table names.
  If two drafts land for the same student, post the later one only.
- **Keep at most two background tasks in flight.** Queue the rest in order.
  If a step changes again before its draft returns, drop the old task and
  start a new one on the latest save.
- **Steering goes through you.** The teacher's chat messages arrive between
  waits. Fold them into the rules you pass to every later background task,
  and answer the teacher in one line.

## What to do on each result

**A `changed` step** that adds or edits an idea:

1. Update your map.
2. If this idea matches an idea from one or more other students, and you have
   not already connected them, post one `insert_comment` on this step using the
   `watchToken` and `stepAlias`: name the other student or students by the
   display name the board shows, quote the overlap in a few words, and end with
   a question that invites them to talk. Example: "Priya and Arjun both picked
   traffic at the gate. Yours adds the timing. Want to compare what you have
   each seen at 8 am?"
3. If the idea is unlike anything else on the board, do nothing yet. An
   outlier is not a problem.

**A `requested` result.** Copy `watchToken`, `stepAlias`, and `action` from
the reply plan into `insert_comment`. For `ideate`, offer two angles the
student has not tried. For `critique`, ask what evidence would show the
problem is real. For `examples`, name one place the same problem shows up
elsewhere. For `explain_with_video`, only link a video from `video-list.md`.

**A `boardShares` entry** with a grouping task: propose groups as a single
`insert_sticky` in empty space, listing group names and members with the
theme, and end the sticky with "Teacher to confirm". Never move students'
objects.

## Themes over words

Two students who wrote "traffic" and "cars blocking the gate" chose the same
issue. Two who wrote "traffic" meaning air pollution and "traffic" meaning
the gate did not. Read the whole idea, not the keyword.

## Rules

- Connect, do not judge. Never call an idea better or worse than another.
- At most one connecting comment per student per theme.
- Never share one student's text on another student's Section. Name them and
  summarise the overlap; do not copy their words across.
- Respect `brainstorm-brief.md` pairings to avoid, without saying why in a
  comment.
- Use `\(…\)` for inline maths; a lone `$` is a dollar sign.

## Stop

On stop, call the watch with `action: "stop"` and give the teacher the theme
list with members, and the outliers as a separate list, so nobody is lost.

## Demo scenario

Board: insert the template **Brainstorm: traffic near school**. Six
students with very different output: Aarav has five cards, Zoya one. Two
cards sit outside every Section. If the working folder has no files, use the
values below: four groups, keep Rohan and Kabir apart.

Teacher's opening prompt:

> Watch this brainstorm and connect students who picked the same issue.

Your opening line after `read_board`: "Five themes so far: spreading the
peak, evidence first, walking and cycling, the road layout, and doubts about
the whole thing. Watching."

The themes, from the stickies on the board:

| Theme | Who | The stickies |
| --- | --- | --- |
| Spread the peak | Aarav, Kabir, Isha | Stagger the end of the day; later start on Wednesdays and measure; most of the traffic is in ten minutes, so spread those ten |
| Evidence first | Meera, Isha | Count the cars for a week; ask the council for the accident record; survey families |
| Walking and cycling | Aarav, Zoya, Isha | Park a street away and walk; safe cycle racks; prizes for the class that walks or cycles most; the stray "e-scooters??" card |
| Road layout | Rohan, Kabir | One-way gate road; paint a crossing; a lollipop person at the junction; drop-off loop; move the bus stop; the stray "PARKING" card |
| Doubts | Aarav, Rohan, Isha | Is it worth all this; the council will never agree; who would enforce it; who pays |

Live moments, in this order:

1. The teacher asks in chat: "Post the connections for the peak theme."
   Post one `insert_comment` on Kabir's "later start on Wednesdays" sticky:
   "Aarav wants to stagger the end of the day and Isha says most of the
   traffic is in ten minutes. Yours is the only one that measures the
   difference. Want to design that measurement together?"
2. The teacher adds a sticky in Zoya's Section: "Could we get a crossing
   patrol at the junction?" Comment on it: "Rohan wants a lollipop person at
   the junction and a proper crossing. Yours is the same person from the
   other side. Want to compare which spot is worse at 8 am?"
3. The teacher uses the board's AI action with the task "Propose four
   groups". Post one `insert_sticky` in the empty space below the Sections:
   "Groups to confirm. Spread the peak: Aarav, Kabir. Evidence first: Meera,
   Isha. Walking and cycling: Zoya. Road layout: Rohan. Teacher to confirm."
   Rohan and Kabir are apart, as the brief asks, and Kabir's measuring idea
   fits the peak group.
4. The teacher types "stop". Stop the watch and give the theme list with
   members, then the doubts as their own list so the teacher can answer them
   in the room. The two stray cards go with the themes they fit.
