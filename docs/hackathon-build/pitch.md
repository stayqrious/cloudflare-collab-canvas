# SpaceScale: multiplayer AI with the teacher at the controls

**One shared canvas, a whole class, and one AI that sees everyone's work at
once. The teacher decides what it knows, what it may do, and when it wakes up.
WebMCP is what makes that possible without a backend, a model key, or an
extension.**

Live demo: [webmcp.spacescale.net](https://webmcp.spacescale.net/) ·
Code: [github.com/shankarram-sq/spacescale](https://github.com/shankarram-sq/spacescale)

---

## The gap

AI is mainstream. Almost all of it is single-player: one person, one chat, one
private answer. A classroom is the opposite of that. Thirty people are working
on the same problem at the same time, at different speeds, with different
misconceptions, and the person who knows them best is standing at the front of
the room.

Multiplayer AI, where one agent watches a shared workspace and responds to each
person inside it, is rare. Multiplayer AI that the *host* controls from their
own device, with their own notes and their own rules, without anyone shipping
a server, is rarer still. That combination is what SpaceScale builds, and it is
what WebMCP uniquely enables.

## Few special features of this implementation

### 1. Two-way WebMCP: the page can invoke the agent

WebMCP lets an agent call tools on a web page. SpaceScale also runs it the
other way. While a watch is live, the board grows an **Ask AI** button in its
selection toolbar and an **AI** action in the tool rail. A student selects
their step and picks *Explain*, *Critique*, *Check my work*, *Examples*, or
*Explain with a video*. The teacher can hand the whole board over with a task.

That request travels back to Codex on the watch's next long poll, together
with the step's content and a reply plan naming the exact tool call to answer
with. The agent replies as a comment on that step. The website is no longer
just a target of tool calls. It is a participant that can ask.

Today this rides on bounded 20-second long polls, which is enough to feel live
in a classroom. When WebMCP gains a push or subscription mechanism, the same
tools drop straight onto it.

### 2. Collaboration on the site, knowledge on the client

The logic of the lesson lives in the teacher's own skills and files. A skill
file encodes the pedagogy: when to hint, when to hold back, when to reach for
a video. Local documents supply the knowledge: the class notes, the marking
scheme, the video list. The teacher adds or edits these on their own machine,
and Codex applies them to the live board. What SpaceScale itself does not do
today can be added the same way, as a skill or a file, without touching the
site.

The site does what only the site can do: hold the live state, show who wrote
what, capture handwriting strokes, collect a vote, and put the agent's
answer in front of the right person in real time. The client does what only
the teacher can do: decide the mode, the rules, and the background material.

This split is the personalisation story. A skill is a text file. Two teachers
in the same school can run the same board with different coaching styles. A
department can share one skill and edit it on a Friday afternoon. Nothing
deploys. Five are in the repo today, under `.agents/skills`: a problem-set
coach, a brainstorm connector, a debate mapper, a handwritten-working checker,
and a follow-one-student coach, with an install guide.

### 3. Handwriting and diagrams, not just text

Most digital learning tools can only evaluate what a student types. The
richest evidence of thinking is not typed. It is the working: the steps of a
long division, the free-body diagram, the number line with the jump drawn in
the wrong direction. That is exactly the work digital setups usually cannot
assess.

On SpaceScale, students write with a Huion pen tablet or any other graphics
tablet, and their strokes land on the board as ordinary pencil paths. The
watch hands those strokes to the agent, which analyses the writing and the
drawing as the student saved them. Huion simply makes this feel the same as
writing on paper. Nothing about the pedagogy has to change to make it
machine-readable.

That opens up the deep end of feedback. The agent can follow a multi-step
solution and point at the step where it went wrong. It can read a diagram and
check it against the claim beside it. The demo board shows a hand-drawn
parabola with the roots marked in the wrong place. The agent sees the sketch,
notices that the student's own arithmetic already contradicts the claim, and
asks them to plot one point before fixing the curve. That is feedback on
visual work, on the canvas where it was drawn.

## Why this is new

Each piece exists somewhere. A tutor bot can give hints. A chat can summarise a
brainstorm. A vision model can read a graph. What did not exist is all of it
running at once, in real time, on a shared space, personal to one teacher's
notes and rules, with the agent holding exactly that teacher's permissions and
nothing more.

WebMCP is the reason it fits together. The most valuable context in a lesson
is not in any database. It is the live page: who is on which step, what they
just saved, what they selected, how the class voted. WebMCP hands that context
to the agent directly, and hands the agent's answer back to the page, without
DOM scraping, a browser extension, or a second server.

## What it looks like in a classroom

A teacher assigns five problems. Every student has a Section of the board and
works in it, typing or writing by hand on a pen tablet. The teacher starts a
board watch from Codex with the class notes and a coaching skill loaded.

From then on, without the teacher prompting again:

- A student who finishes early gets a fast-finisher question pinned beside
  their last answer.
- A student stuck on question three gets a hint on that exact step. A hint, not
  the answer, because the teacher's skill says so.
- A student who is struggling across every problem gets a two-minute video,
  chosen from the resources the teacher provided, attached to a comment on
  their work.

When one student needs more of the teacher's attention, the teacher can point
the watch at that one student's work instead of the whole board. Following a
student is something the teacher starts, everyone can see, and that expires on
its own.

Each of these lands as an ordinary canvas object, marked as AI-written,
attributed to the teacher, visible to whoever should see it, and undoable in one
click. The teacher never left the board.

Two more scenes, same machinery, different skill:

- **Brainstorm.** Six students each list problems near the school. The agent
  notices that three of them chose traffic at the gate and leaves a comment
  connecting them, so the groups form themselves.
- **Debate.** Two sides argue. The agent comments on each side's Section with
  the assumption their argument rests on, phrased as a question, so the next
  round is about evidence rather than volume.

## Built for education, open to any room

The fourteen tools are deliberately generic. Read once or follow live, over
three scopes: the whole board, the current selection, or one named person's
work. A participant list, a vote reader, and a template reader. Six writes:
comment, sticky note, image, video, filled template, and atomic sticky-note
movement. Nothing in the protocol knows what a lesson is. The education
behaviour lives in the skill.

Swap the skill and the same board becomes:

- a marketing war room where the agent connects campaign ideas that target the
  same audience and flags the assumption under each one;
- a project retrospective where it groups sticky notes by root cause and drops
  a follow-up question on each cluster;
- a design critique where it reads the sketches and comments on the flow.

## Safe by construction

- The agent has no identity of its own. Every write runs as the participant
  who started the watch, through the same commit path as their own edits, and
  the Cloudflare Worker revalidates role, ownership, and locks before saving.
- A viewer's agent is read-only. An editor's agent can add work but cannot
  rewrite another student's.
- Every AI contribution carries a visible AI mark and provenance metadata, and
  undoes in one step.
- The watch never sees unsaved keystrokes, stable IDs, presence, or history,
  and expires after fifteen minutes.
- Following one student reports strictly less than watching the board, and
  the participant list counts how much work exists, never how well anyone is
  doing. The safety gate forbids grading, ranking, or profiling from it.

## Try it in three minutes

1. Open the demo in a WebMCP-capable host and insert the **Problem set: six
   students** template.
2. Ask the host to start `watch_board`. Edit one student's answer, then press
   **Ask AI** on a step and choose *Check my work*.
3. Watch the reply arrive as a comment on that step, marked as AI, attributed
   to you, and one undo away from gone.

## Honest limitations

- **It gets chatty at scale.** With many students saving work at once, one
  watch delivers a lot of changes to one agent, and replies slow down. It suits
  a small group today.
- **The watch has to stay with the main agent.** A Codex background agent
  has no access to the browser, so it cannot call the board's tools. The
  skills keep the watch loop and every tool call in the teacher's main
  session and hand only the analysis of each step to background agents,
  which return draft comments. The teacher steers the main agent with short
  comments in chat.
- **Multiple agents are the answer, and they are not reliable yet.** The
  skills ask for up to two background analysis tasks in flight so the main
  agent stays responsive. Codex accepts the instruction, but the behaviour
  needs more testing before a full class leans on it. It is a prompt and
  skill change, so the site does not have to move for it.

## What comes next

- Make the multi-agent watch reliable on Codex so a full class can work at
  once with fast replies.
- Replace long polling with a push channel the moment WebMCP offers one.
- Grow the skill library past the first five, with a plain-language editing
  guide for teachers.
- Pilot in our own StayQrious classrooms with the safety and data-governance
  gate already documented in the repo.
