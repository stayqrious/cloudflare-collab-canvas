# Title

SpaceScale

## One-line Summary

SpaceScale is a multiplayer canvas where students draw and write together while AI coaches each learner in real time—using two-way WebMCP polling, guided by the teacher’s own skill and knowledge files.

## Problem

Most AI tools are designed for one person in a private chat. A classroom works differently: students learn together, progress at different speeds, and express their thinking through handwriting, diagrams, equations, sticky notes, and discussion.

Effective classroom AI must also understand the teacher’s intent. The same response may be helpful in one lesson and disruptive in another. The AI should reflect the teacher’s lesson plan, terminology, examples, learning objectives, and rules about when to give a hint, ask a question, show a video, or explain a concept.

That context is difficult to capture in a generic prompt. Without it, AI can give premature answers or teach in a way that conflicts with the lesson. Teachers need an assistant personalized by their own plans and knowledge while retaining control over how it responds and what it may change.

## How SpaceScale Started

I created Cloudflare Collab Canvas and made it open source from the beginning because I saw its potential beyond StayQrious. It is still a young foundation, but it was designed with AI collaboration in mind and runs entirely on the Cloudflare stack.

Cloudflare Collab Canvas could already share board state through server-side calls, but that approach still required a central integration. A centralized AI system is difficult to personalize around each teacher’s lesson plans, knowledge, and preferred teaching style.

SpaceScale builds on that foundation and uses WebMCP to move the AI interaction into the browser. Teachers can use their own Codex, skills, and knowledge files instead of depending on a centrally configured assistant.

## What SpaceScale Does

SpaceScale is a live, multiplayer canvas where students, teachers, and AI agents work in the same shared environment.

Students and teachers can draw, write, organize ideas, comment, vote, use activity templates, and embed lesson videos. A WebMCP-capable agent can understand the board, follow saved work as it changes, and place useful material directly beside the work it relates to.

Instead of disappearing into a private chat, AI assistance becomes part of the shared canvas. It can appear as a hint attached to a calculation, a counterexample beside an incorrect graph, a relevant video near a lesson, a filled activity template, or a clearer arrangement of sticky notes.

Every AI-assisted contribution is visible to collaborators, synchronized in real time, attributed to the teacher who authorized it, and reversible with normal undo.

## Why WebMCP Matters

The most useful classroom context already exists inside the page: the current selection, handwritten working, diagrams, spatial relationships, saved changes, participant-authored objects, and aggregate class votes.

WebMCP gives the teacher’s agent structured access to that live context without DOM scraping, a browser extension, or a separate SpaceScale AI backend.

SpaceScale exposes fourteen WebMCP tools:

- Six reads inspect the board, current selection, one participant’s work, participant list, aggregate class votes, and available activity templates.
- Two watches follow the board, a fixed selection, or named participants for up to fifteen minutes through bounded polling.
- Six writes add comments, sticky notes, images, videos, filled templates, or atomically rearrange existing sticky notes.

The tools are intentionally generic. The teaching behavior comes from the teacher’s own skill and knowledge files. Those files determine how the agent should coach, which material it should use, what it should avoid, and when it should intervene.

Changing the skill allows the same canvas to support problem-set coaching, brainstorming, debates, design critiques, project retrospectives, and other collaborative work.

## Ask AI as a Teacher Coaching Tool

**Ask AI** is designed as a coaching tool for the teacher, not as a shortcut that gives students answers.

A teacher can use it to quickly understand what is happening across the class: check responses from multiple students, identify a shared misconception, bring a relevant video onto the board, or suggest peer pairings based on the work students have shown.

The teacher can also select a specific student’s Section and request focused assistance through their own Codex. The agent receives the selected classroom context and responds using the teacher’s lesson plan, knowledge files, coaching approach, and permissions.

This creates a two-way WebMCP workflow. The agent can read and act on the page, while the teacher can send a request from the page back to the agent through the next watch poll. The result then returns to the shared canvas through a permission-bound WebMCP action.

The teacher remains in control throughout the process.

## Permission-Bound by Design

SpaceScale does not give the AI a privileged bot identity. Every WebMCP action uses the permissions of the participant who authorized it.

A viewer’s agent remains read-only. An editor’s agent can create content but cannot rewrite another participant’s work. Owners and co-owners retain their normal controls.

Before saving a WebMCP action, the Cloudflare Worker revalidates the participant’s role, ownership, section locks, object versions, and the complete action batch. Accepted changes follow the same acknowledged, real-time path as human edits.

AI-assisted content carries visible provenance and remains undoable. Watches use temporary aliases rather than exposing stable internal object identifiers.

## What I Built During the Challenge

SpaceScale is an existing project built on the open-source Cloudflare Collab Canvas foundation. During the WebMCP Challenge, I extended it into an AI-enabled collaborative learning environment.

I added the fourteen-tool WebMCP surface, board and participant watches, teacher-initiated **Ask AI** requests, permission-bound acknowledged writes, visible AI provenance, handwriting and diagram support, comments containing pictures or videos, activity templates, shared video cards, per-student Sections, classroom roles, demonstration boards, automated test coverage, and five installable Codex teaching skills.

The application uses TypeScript, Cloudflare Workers, Durable Objects, SQLite, R2, Vite, and Playwright. A `BoardRoom` Durable Object validates, sequences, stores, and broadcasts each durable action. The application continues to work as a complete collaborative canvas when WebMCP is unavailable.

## How I Used AI

The visiting WebMCP agent provides the reasoning; SpaceScale provides the structured live context and safe actions. In the classroom examples, the agent checks handwritten working, identifies reasoning errors, gives hints instead of complete answers, compares responses, connects related ideas, suggests peer support, and brings relevant learning material onto the board.

## How I Used Claude Code and Codex

I used both Claude Code and Codex extensively while building SpaceScale. They supported product exploration, architecture, WebMCP tool design, implementation, automated testing, debugging, code review, documentation, demo preparation, and submission writing.

Codex is also the reference agent for the live demonstration. It runs with teacher-authored skills and local knowledge files, discovers SpaceScale’s tools through WebMCP, and acts under the teacher’s existing permissions.

## Try It

Open the [live SpaceScale demo](https://webmcp.spacescale.net/) in ChatGPT’s in-app browser or Google Chrome with WebMCP enabled.

Create a Space and insert **Graph check: one student’s working** from Templates. Select the graph and equation and ask the agent whether they agree. Then select the student’s claim and ask for a counterexample at `x = -4`.

The AI should add feedback beside the work showing that `16 - 28 + 10 = -2` and asking the student to plot `(-4, -2)`.

Open a viewer invitation in a second session to confirm that the feedback synchronizes, the viewer cannot perform the same write, and the owner can remove the contribution with one undo.

The [public repository](https://github.com/shankarram-sq/spacescale) contains the source code, setup instructions, automated tests, technical specification, screenshots, and complete demo runbook.

## Testing Instructions

1. Open [https://webmcp.spacescale.net/](https://webmcp.spacescale.net/) in a
   WebMCP-capable host such as Codex in a compatible browser. No account is
   required for the demo.
2. Enter a board title, choose **Open a fresh canvas**, then **Continue to
   board**.
3. Open **Templates** and insert **Problem set: six students**. Ask the host to
   start `watch_board`. As the teacher, edit or review one student's answer,
   select that student's step, press **Ask AI**, and choose **Check my work**.
   Confirm the reply arrives as a comment on that step, marked as AI,
   attributed to you, synced to a second session, and removed by one undo.
4. For handwriting, insert **Graph check: one student's working**. Ask the
   agent to check the drawn curve against the equation, then ask it to add a
   counterexample at `x = -4`. Confirm the card computes `y = -2` and asks the
   student to plot `(-4, -2)`.
5. From **Access**, create a viewer invite, open it in a private window, and
   try the same write. Confirm the viewer's agent cannot commit.
6. Choose **Video**, paste a public YouTube or Vimeo URL, and confirm the shared
   card can be selected, moved, and seen from the second session.
7. For local verification, use Node.js 22.19+, run `npm install`, then
   `npm run check` and `npm run test:e2e`.

Detailed prompts and recovery paths are in
[`docs/hackathon-build/demo-runbook.md`](docs/hackathon-build/demo-runbook.md).
The full pitch is in
[`docs/hackathon-build/pitch.md`](docs/hackathon-build/pitch.md).

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
   privacy-conscious video card, mathematical notation, and collaborative
   canvas tools.
4. `docs/submission-assets/handwriting-visual-review.png` — optional technical
   evidence for handwriting analysis.

Use the first image as the project thumbnail if Devpost accepts the same crop;
otherwise crop it to Devpost's requested aspect ratio without adding claims or
sensitive data.

## Submission Readiness Notes

- Live URL: provided and publicly reachable.
- Repository: public, with all source, setup instructions, tests, documentation,
  assets, and a detectable MIT license.
- WebMCP fit: explicit in the README, pitch, implementation spec, test
  instructions, and demo runbook.
- Existing-project disclosure: explicit, with challenge-period functional delta.
- Screenshots: committed under `docs/submission-assets/`.
- Demo script: timed to finish under three minutes and includes visible tool use,
  handwriting, Ask AI, author-scoped permission proof, video, realtime sync, and
  undo.
- Outstanding item: replace the single YouTube placeholder above after upload.

## Known Limitations

- WebMCP tools require a compatible host. The canvas itself still works in a
  normal browser without site tools.
- The page-to-agent direction currently rides on bounded 20-second long polls.
  When WebMCP offers a push or subscription mechanism, the same tools move onto
  it.
- The watch gets chatty when many participants save work at once and replies
  slow down. It suits a small group today.
- A Codex background agent has no access to the browser, so it cannot call
  the board's tools. The skills keep the watch and every tool call in the
  main agent and delegate only the analysis of each step to background
  agents, which return draft comments. The teacher steers the main agent
  with comments in chat.
- The multi-agent split, with up to two background analysis tasks in flight,
  is what keeps the main agent responsive. Codex accepts the instruction but
  the behaviour is not yet reliable and needs more testing. It is a prompt
  and skill change, not a site change.
- The public deployment is a hackathon demo for synthetic or non-sensitive
  content; real classroom rollout requires the documented safety,
  administration, and data-governance gate.
- Video cards embed supported lesson media but do not send a video's audio,
  transcript, or frame pixels to the agent.

## Official Form Fields

The following answers are prepared for the Devpost form:

- **Submitter Type:** Individual
- **Country of residence:** India
- **Organization name:** Leave blank
- **App Status:** Existing
- **If Existing, what was updated during the submission period?** Use the
  “What I Built During the Challenge” section above.
- **Live URL:** https://webmcp.spacescale.net/
- **Testing instructions:** Use the numbered “Testing Instructions” above.
- **Public repository:** https://github.com/shankarram-sq/spacescale
- **Agents/clients tested:** Codex in a WebMCP-compatible browser host; Chromium
  with a standards-shaped `document.modelContext` harness for automated tests.
- **AI tools leveraged:** Claude Code and Codex for product exploration,
  architecture, WebMCP tool design, implementation, automated testing,
  debugging, review, documentation, demo preparation, and submission writing.
  Codex is also the reference demo agent, driven by teacher-authored skills and
  local knowledge files.
- **Learning level:** Significant
- **Gained AI career value:** Yes
- **Demo video:** TODO — paste the final public YouTube URL.
