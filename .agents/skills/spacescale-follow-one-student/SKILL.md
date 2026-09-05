---
name: spacescale-follow-one-student
description: Follow one named student's work on a SpaceScale board with close coaching. Use when a teacher opens a SpaceScale board in Codex and asks you to follow, watch, or focus on one student or a small named group, for example a student who is struggling or needs extra support. Do not use for whole-class watching; the problem-set coach covers that.
---

# SpaceScale: follow one student

The teacher has asked you to give one student, or a small named group, closer
attention than the whole-class watch allows. This is the one place a watch
points at a person rather than a region, so it follows tighter rules.

## Before you start

1. Read `class-notes.md`, `video-list.md`, and `rules.md` in the working
   folder if they exist. If the teacher has a `support-notes.md` for this
   student (the approach they want, what has worked), read it and follow it.
   Files override this skill.
2. Call `list_users` to get the participant IDs the user tools take. It lists
   people with saved work, by display name, with how many objects they have.
   Those counts say how much work exists, never how well anyone is doing.
3. Match the teacher's name for the student to a display name. If two names
   could match, ask; do not guess.
4. Tell the teacher which student you will follow and start only when they
   confirm. This is teacher-initiated, visible on the board, and expires.

## Run the watch

- `watch_users` with `action: "start"` and `participantIds` for the student.
  Loop on `action: "wait"` with the `watchToken`, `afterSeq`, and
  `waitMs: 20000`, following `nextCall`.
- The watch follows that student's work wherever it sits on the board,
  including what they save while it runs. A change to their object by
  someone else is reported without naming the other person.
- To read once without watching, call `read_user` with the same IDs.
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

## How to coach

Reply on the student's own work with `insert_comment` using `watchToken` and
`stepAlias`. Pace yourself: one comment per meaningful step, and let a
student sit with a hint before adding another. A student under close watch
should feel supported, not chased.

- Start every comment with what is right. Then one thing to check. Then one
  question.
- Break the next step smaller than you would for the class. If the class
  hint is "check the sign", the hint here is "what is \(-3 \times -1\)?"
- When the student is stuck across two saves in a row, switch mode: give a
  smaller worked example of the same step, then ask them to try theirs.
- When they are stuck across three, attach a video from `video-list.md` with
  `videoUrl` and tell the teacher in chat that this student may need them in
  person.
- When a `requested` result arrives, answer the action the student chose,
  copying `watchToken`, `stepAlias`, and `action` from the reply plan.

## Handwriting

Drawn work arrives with a description and a picture of the board. Read the
strokes. Say when you cannot read something and ask for a rewrite of that
part only.

## Rules

- Never grade, rank, profile, or compare this student to anyone, in comments
  or in chat. The teacher asked you to help, not to assess.
- Never say in a comment that the student is being followed more closely.
- Never report what other students are doing. This watch does not show them.
- Comments under fifty words. Hints, not answers.
- Use `\(…\)` for inline maths; a lone `$` is a dollar sign.

## Stop

Stop when the teacher says so or when the watch expires, with
`action: "stop"`. Give the teacher three lines: where the student started,
where they got to, and the one thing to pick up next time. No scores.

## Demo scenario

Board: insert the template **Problem set: six students**. Isha has written
questions 1 and 2 by hand, both right, and questions 3 to 5 are blank. If
the working folder has no files, keep every comment to one line and one
question.

Teacher's opening prompt:

> Follow Isha on this problem set.

Call `list_users`, match "Isha" to the participant with that display name,
and say: "I will follow Isha's Section only. Start?" Wait for "yes", then
`watch_users` with her participant ID.

First comment, on Isha's Q2 working: "Both right so far. Question 3 has a
bracket and a power. Which comes first?"

Live moments, in this order. The teacher writes in Isha's Section between
each:

1. Q3 appears as \((8 - 3) = 5\), \(5 \times 2 = 10\). Comment: "Bracket
   first, good. Does \(5^2\) mean \(5 \times 2\) or \(5 \times 5\)?"
2. Q3 is saved again, still 10. Two saves stuck, so switch mode. Comment:
   "Smaller one: \(3^2 = 3 \times 3 = 9\). Now \(5^2\)?"
3. Q3 is saved again, still 10. Three saves stuck. Comment with `videoUrl`
   `https://www.youtube.com/watch?v=eoYThjIAhOc`: "Watch from 1:00, the part
   about powers. Then try question 3 once more." In chat, tell the teacher:
   "Isha may need you in person on question 3."
4. Q3 becomes 25. Comment: "That is it. Question 4 next: start at \(-4\)
   and move 9 to the right."
5. The teacher types "stop". Stop the watch and give three lines: started
   with two right and three blank; got question 3 after a stall on powers;
   pick up powers with one more example next time.
