# Title

SpaceScale

## One-line Summary

A teacher-controlled WebMCP agent that can watch the whole working board or a
selected region, then adapt feedback, challenges, and learning resources for
each student inside the live classroom.

## Problem

ChatGPT, Claude, and MCP already work well for individual tasks and multi-step
automation. What they do not naturally provide is controlled participation in
a live, multi-user classroom. A teacher may have the lesson plan and class notes
in their own agent, but that agent cannot normally watch evolving work across a
shared board, respond differently to each learner, and return its help to the
room without becoming a privileged server bot.

## Solution

SpaceScale is a realtime visual classroom built on Cloudflare. Students and
teachers draw, write, organize, comment, vote, and embed YouTube or Vimeo videos
on one durable canvas. Work can be created directly on the board or arrive from
a stylus, tablet, or smart-paper workflow such as a Huion Note.

The teacher opens the board with their own compatible browser agent—the same
agent that can already hold the lesson plan, class notes, rubric, and teaching
instructions. They can select all relevant saved work on the board or draw a
selection around one region, then start a 15-minute watch. The current watcher
follows up to 30 selected, server-acknowledged text-bearing items; the companion
visual tool inspects selected handwriting, diagrams, arrows, and spatial work.

As the class works, the agent can respond differently to the same lesson. It
can identify the first concrete error in a student's diagram, generate a tougher
question for an early finisher, explain a step at a smaller grain, suggest a
lesson video, or turn a debate into a map of assumptions, agreements, tensions,
and unresolved questions. Replies return to the board as AI-marked comments or
source-linked canvas objects that the whole class can inspect and revise.

The page registers sixteen semantic WebMCP tools. Every write uses the
authorizing participant's current actor ID and role, enters the same durable
commit path as their own edits, and is revalidated by the Worker before it is
saved. The teacher controls the agent's scope; the application controls what
that teacher-authorized agent can actually do.

## Why This Matters

This changes the unit of classroom AI from one student and one chat to one
teacher-directed agent participating in a shared learning environment. The
teacher can watch the full working set or focus on one region, while each
learner receives a different next move in the same visible space.

It also creates a collaboration loop that was difficult before: student work
changes, the agent notices the saved step, the learner or teacher asks for a
specific kind of help, and the response appears beside the source work for
everyone who needs it. Early finishers can keep moving, stuck learners can get a
targeted explanation or video, and debates can expose exactly where assumptions
diverge instead of collapsing into a generic summary.

The model never chooses its own authority. A viewer's agent remains a viewer.
An editor's agent can create new work but cannot rewrite another participant's
work. An owner's agent has only the owner's normal access. The teacher remains
the person directing the classroom agent; the server continues to enforce the
rules of the shared room.

## How We Used AI

SpaceScale deliberately contains no embedded model API key and sends no board
prompt to a separate SpaceScale AI backend. The visiting browser agent performs
the reasoning and can bring the teacher's existing class notes, lesson plan,
rubric, and instructions into the session. The page contributes the live context
only it owns: the teacher-chosen board scope, canonical saved objects, a visual
of the selected region, authoritative change cursors, current permissions, and
aggregate vote state.

The watch turns that agent into a live classroom participant. Each saved change
can trigger a response cycle, and the board's **AI** menu lets a learner or
teacher ask for Explain, Ideate, Critique, Check my work, Examples, or Explain
with a video without leaving the canvas. The host replies through an AI-marked
comment or one of the existing source-linked education tools, then continues
watching.

AI is also used to interpret handwriting and diagrams, generate appropriately
hard follow-up questions, structure inquiry and debate maps, identify explicit
assumptions and disagreements, and stage decisions that preserve unresolved
minority concerns.

## How We Used Codex

Codex was the primary engineering partner for the WebMCP Challenge work. It
helped translate the classroom collaboration idea into semantic tool contracts,
implement the WebMCP adapters and deterministic canvas compilers, reason through
visual feedback and participant-scoped authorization, write unit/edge/browser
coverage, debug realtime acknowledgement behavior, and prepare the public demo,
recording script, and submission documentation.

The project also uses Codex as the reference demo agent: it discovers the tools
from the live page, reasons over only the participant-approved context, and
returns results through permission-bound site actions.

## Key Features

- A teacher-scoped, 15-minute classroom watch over the relevant saved work:
  select all text-bearing items for the working board or marquee-select one
  learner or group region.
- A board-native **AI** menu for Explain, Ideate, Critique, Check my work,
  Examples, and Explain with a video while the watch is live.
- Differentiated interventions: a concrete correction for a misconception, a
  tougher follow-up for an early finisher, a smaller explanatory step for a
  stuck learner, or a lesson-video recommendation.
- Handwriting and sketch inspection through the board's canonical SVG renderer,
  so the agent can reason about equations, diagrams, arrows, and spatial work.
- Debate and decision tools that make assumptions, agreements, tensions,
  unresolved questions, votes, and minority concerns visible.
- AI-authored, source-linked feedback that can turn a visual misconception into
  a concrete next action, such as plotting `(-4, -2)` to correct a quadratic.
- Shared public YouTube and Vimeo cards that persist, synchronize, select, move,
  copy, and delete like other canvas objects.
- Same-author permission inheritance: no service account, no elevated agent
  role, local preflight plus authoritative Worker enforcement, and success only
  after server acknowledgement.
- Sixteen discoverable WebMCP tools spanning selection reads, visual inspection,
  saved-step watching and comments, 27 classroom collaboration modes, content
  visuals, inquiry maps, aggregate votes, and class decisions.
- Source-linked AI contributions that are attributed to the authorizing
  participant, broadcast in real time, committed atomically, and undoable.
- A replaceable skill-and-template layer that can reuse the same canvas for
  marketing brainstorming or visual Linear planning without changing the
  underlying watch, collaboration, or permission system.

## Architecture

The TypeScript browser application registers tools with
`document.modelContext.registerTool` when the API is present and remains a full
collaborative canvas when it is absent. Read receipts and watch sessions are
bounded and live only in page memory. Write tools accept semantic intent—not raw
coordinates, arbitrary HTML, or actor identity—and compile it to protocol-valid
board operations.

All writes flow through the participant's durable outbox and WebSocket session.
One `BoardRoom` Durable Object per board validates role, item ownership, section
locks, versions, topology, and batch limits before a shared reducer sequences
and persists the action to SQLite. The resulting authoritative action resolves
the WebMCP promise and is broadcast to collaborators. Private raster assets,
recovery checkpoints, and named snapshots use R2.

### Skills package the domain workflow

The education experience is one skill layer over a reusable collaboration
substrate. SpaceScale owns the live board, watches, sections, templates,
comments, attribution, undo, and permission-bound inserts. A local Codex skill
can package the prompts, decision rules, and WebMCP call sequence for a
particular domain. Repo-local skills can travel with a project, while plugins
can distribute the same workflow and declare connector dependencies.

For example, swapping `check-maths-steps` for a `marketing-brainstorm` skill and
matching organisation template can turn the canvas into sections for a brief,
evidence, campaign angles, critiques, experiments, and owners. The agent can
watch the same shared board, cluster contributions, challenge assumptions, and
insert source-linked next actions without changing the realtime or
authorization architecture.

A `linear-planning` skill can additionally use a Linear MCP connector in the
same agent session. It can list issues, place normalized issue cards into status
or assignee sections, and let the team debate ownership visually. Only a
confirmed Linear tool call writes an assignment back; rearranging the canvas is
a collaborative planning action, not an implicit external mutation.

The current demo ships the education workflow. Marketing and Linear are direct
extension paths: package a different skill and template, add the required
connector when external data is involved, and keep the SpaceScale WebMCP,
watch, permission, persistence, and collaboration layers unchanged.

## What We Built During the Challenge

SpaceScale is an **existing project** based on the open-source Cloudflare Collab
Canvas foundation. During the WebMCP Challenge submission period, the project
was meaningfully extended from a secure collaborative whiteboard into an
AI-enabled learning product. The challenge work added:

- the sixteen-tool WebMCP integration and 27 enforced education modes;
- the 15-minute saved-step watcher, board-native AI request menu, and
  AI-authored watched-step comments;
- selected semantic, visual, explanatory, inspiration, vote, and saved-change
  read surfaces;
- the participant-scoped WebMCP commit/acknowledgement path and attribution;
- inquiry-map, decision, learning-scaffold, and source-linked visual compilers;
- handwriting masking and visual-review safety boundaries;
- shared video cards and MathJax learning content;
- classroom roles, object comments, richer grouping/section workflows, a new
  education-focused homepage, and extensive contract/unit/edge/Chromium tests;
- the repo-local `check-maths-steps` example skill, which watches a worked
  solution and responds to the first mistake with a probing question rather
  than revealing the correction;
- the implementation spec, safety gate, judge instructions, screenshot pack,
  and three-minute recording runbook.

The public repository history and the comparison with the upstream foundation
show the complete functional delta.

## Testing Instructions

1. Open [https://webmcp.spacescale.net/](https://webmcp.spacescale.net/) in
   ChatGPT's in-app browser or another environment that exposes WebMCP site
   tools.
2. Enter a board title, choose **Open a fresh canvas**, and then **Continue to
   board**. Keep a second participant session visible.
3. Create two learning regions. In one, enter `x² + 7x + 10 = 0`, sketch a
   deliberately incorrect graph with roots at `-3` and `-1`, and add that
   claim as a sticky. In the other, add a correctly completed step for an early
   finisher.
4. Select all relevant saved steps for a board-wide watch, or marquee-select
   only the first region. Ask the agent to start
   `watch_selected_problem_steps`. Confirm that **AI watching** appears.
5. Choose **AI → Check my work** on the mistaken claim. Ask the agent to check
   `x = -4`. Confirm the AI-marked response computes `y = -2`, asks the
   student to plot `(-4, -2)`, stays beside the source work, and synchronizes
   to the second session.
6. In the early-finisher region, request **Examples** or **Ideate** and ask for a
   tougher follow-up. Alternatively choose **Explain with a video**, then add
   the confirmed public YouTube or Vimeo lesson as a shared card.
7. From **Access**, create a viewer invite and attempt a write through that
   session. Confirm that the viewer's agent cannot exceed viewer permissions.
8. For local verification, use Node.js 22.19+, run `npm install`, then run
   `npm run check` and `npm run test:e2e`.

Detailed prompts and recovery paths are in
[`docs/hackathon-build/demo-runbook.md`](docs/hackathon-build/demo-runbook.md).

## Public Demo Link

[https://webmcp.spacescale.net/](https://webmcp.spacescale.net/)

## Public Repository Link

[https://github.com/shankarram-sq/spacescale](https://github.com/shankarram-sq/spacescale)

License: MIT. StayQrious remains the named copyright holder; Shankar Ram
Akshayakumar is identified as the original author and maintainer.

## Demo Video

TODO: Add the public YouTube URL for the final demo (under three minutes, clear
spoken audio).

## Screenshot Shot List

Upload these in this order:

1. `docs/submission-assets/ai-feedback-correction.png` — lead image: a mistaken
   hand-drawn quadratic and a real WebMCP-generated correction asking the
   student to plot `(-4, -2)`.
2. `docs/submission-assets/homepage.png` — education-focused SpaceScale landing
   page with the WebMCP badge and public product positioning.
3. `docs/submission-assets/media-math-canvas.png` — a live board combining a
   shared video card, mathematical notation, and collaborative canvas tools.
4. `docs/submission-assets/handwriting-visual-review.png` — optional technical
   evidence for selected visual inspection.

Use the first image as the project thumbnail if Devpost accepts the same crop;
otherwise crop it to Devpost's requested aspect ratio without adding claims or
sensitive data.

## Submission Readiness Notes

- Live URL: provided and publicly reachable.
- Repository: public, with all source, setup instructions, tests, documentation,
  assets, and a detectable MIT license.
- WebMCP fit: explicit in the README, implementation spec, test instructions,
  and demo runbook.
- Existing-project disclosure: explicit, with challenge-period functional delta.
- Screenshots: committed under `docs/submission-assets/`.
- Demo script: timed to finish under three minutes and leads with the live
  teacher-scoped watch, differentiated support, handwriting, permissions,
  realtime sync, and video.
- Outstanding item: replace the single YouTube placeholder above after upload.

## Known Limitations

- WebMCP tools require a compatible host. The canvas itself still works in a
  normal browser without site tools.
- A board-wide watch is created by selecting the relevant saved text-bearing
  items and is currently capped at 30; handwriting and diagrams use the visual
  inspection tool alongside the watch.
- SpaceScale does not bundle a first-party Huion Note connector; a smart-paper
  workflow must deliver its strokes to the shared canvas.
- Cross-Group Jigsaw remains behind an authoritative section-context provider;
  the live catalog exposes 27 non-section education modes and reports that
  boundary explicitly.
- Video cards embed supported lesson media but do not send a video's audio,
  transcript, or frame pixels to the agent.
- The public demo packages the education workflow. The marketing and Linear
  skills described in the architecture are extension examples and are not
  bundled in this repository.

## Official Form Fields

The following answers are prepared for the Devpost form:

- **Submitter Type:** Individual
- **Country of residence:** India
- **Organization name:** Leave blank
- **App Status:** Existing
- **If Existing, what was updated during the submission period?** Use the
  “What We Built During the Challenge” section above.
- **Live URL:** https://webmcp.spacescale.net/
- **Testing instructions:** Use the numbered “Testing Instructions” above.
- **Public repository:** https://github.com/shankarram-sq/spacescale
- **Agents/clients tested:** Codex in a WebMCP-compatible browser host; Chromium
  with a standards-shaped `document.modelContext` harness for automated tests.
- **AI tools leveraged:** Codex for product scoping, architecture, implementation,
  tests, debugging, review, and submission preparation.
- **Learning level:** Significant
- **Gained AI career value:** Yes
- **Demo video:** TODO — paste the final public YouTube URL.
