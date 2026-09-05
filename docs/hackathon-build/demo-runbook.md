# WebMCP Challenge demo runbook

This recording script is designed for a public YouTube demo under three
minutes. Lead with a concrete AI intervention on visual student work, then prove
that the same tool remains permission-bound and collaborative.

## Before recording

1. Open [webmcp.spacescale.net](https://webmcp.spacescale.net/) in ChatGPT's
   in-app browser or another compatible WebMCP host.
2. Create a Space named **AI feedback on a quadratic**. Keep a second browser
   session open as a viewer.
3. Open **Templates** and insert **Graph check: one student's working**. It lays
   out the whole scene in one click: a hand-drawn parabola inside a Section
   called *Priya's working* that wrongly marks the roots at `-3` and `-1`, a
   sticky claiming those roots, and a second sticky where the student's own
   check `9 - 21 + 10 = -2` already contradicts the claim.
4. Add one relevant public YouTube or Vimeo lesson video with **Video**. Keep it
   paused beside the work.
5. Hide notifications, close unrelated tabs, set browser zoom to 100%, test the
   microphone, and rehearse once. Every demo board ships synthetic work only.

## Three-minute story

### 0:00–0:20 — one shared AI workspace

Show the equation, mistaken graph, sticky, video card, and two participant
avatars. Say:

> Most classroom AI disappears into private chats. SpaceScale gives people and
> AI one visual workspace, so feedback becomes visible work the class can
> inspect, discuss, and improve together.

Point out **WebMCP enabled**. There is no extension, separate MCP server, or
SpaceScale model API key.

### 0:20–1:18 — AI catches a mistake in visual work

Select the equation and hand-drawn graph. Ask:

> Inspect this selected visual and check whether the plotted curve is consistent
> with the equation. Explain the first concrete issue without solving everything
> for the student.

Let the agent reason about the drawing. Then select the student's claim sticky
and ask:

> Read this selected claim. Use a Counterexample Challenge to add AI feedback
> that checks x = -4 and asks the student to plot the resulting point before
> correcting the curve.

Show the new source-linked card:

- heading: **AI feedback · Check x = -4**;
- calculation: `16 - 28 + 10 = -2`;
- prompt: **Can you plot (-4, -2) and use it to correct the curve?**

Say:

> The AI did not just answer in chat. Its feedback is a WebMCP-generated canvas
> object with AI provenance, a visible link to the student's claim, realtime
> synchronization, and one-step undo.

### 1:18–1:58 — the AI cannot outrank its author

Switch to the viewer session and attempt the same write. Show that it cannot
commit. Say:

> The agent has exactly the permissions of the person who invited it. There is
> no privileged bot identity. A viewer's agent stays read-only; an editor's
> agent can create feedback but cannot rewrite another person's work. The Worker
> checks role, actor, ownership, locks, and the complete batch before saving.

Switch back and undo, then redo or rerun the feedback if useful.

### 1:58–2:33 — feedback lives with the lesson

Pan to the YouTube or Vimeo card and the work around it. Move the video once and
show the second session update. Say:

> Learning is visual and multimedia. Lesson video, handwriting, formulas,
> comments, student claims, and AI feedback stay on one durable shared canvas
> instead of being split across tools and transcripts.

### 2:33–2:58 — close

Show the mistaken plot, the AI correction card, and both synchronized sessions.
End with:

> SpaceScale gives AI a visible seat at the table—not the teacher's chair. Every
> contribution is source-linked, permission-bound, attributable, and
> reversible.

End on the product name and public URL.

## Recovery prompts

If the host does not choose the tools automatically:

- Visual reasoning: “Call `watch_board` with action `start`, read the
  `boardImage` it returns, and check the graph against the equation.”
- Correction comment: “Answer the request the watch delivered by calling
  `insert_comment` with the `watchToken`, `stepAlias` and `action` from its
  reply plan. Say what is already right, then point at `x = -4`.”
- Correction card: “Call `insert_sticky` with a `location` beside the plot, a
  counterexample checking `x = -4`, and a question the class can act on.”
- Worked example or clip: “Call `insert_comment` on the same step, and pass
  `imageDataUrl` with `alt` for a picture of the correct sketch, or `videoUrl`
  with a public YouTube or Vimeo link, so the material sits with the work.”

If a write fails unexpectedly, confirm that the participant has edit access,
that the Space has that object kind enabled, and that the step finished saving.
A comment needs a target: pass the watch's `watchToken` and `stepAlias`, or a
`location` on the object, or leave exactly one object selected.

## Demo boards

Seven templates stage a demo in one click, so no scene has to be drawn live. Each
one is student work and nothing else: there is no block waiting for the AI,
because the AI answers in comments, which is the thing worth showing. Nothing on
any of them belongs to a real student.

| Template | What it stages |
| --- | --- |
| **Graph check: one student's working** | A hand-drawn parabola with the roots marked at `-3` and `-1`, and the student's own arithmetic already disproving it |
| **Need to know: eclipses** | Six students, a Section each, three questions apiece before the topic starts |
| **Brainstorm: traffic near school** | Six students, a Section each, ideas and objections about a real school problem |
| **Problem set: six students** | Six students on the same five problems with their working shown, typed and handwritten. One has every answer right, one has two wrong, two stopped at question two |
| **Debate: a 9 am start** | Five claims for, two against, and one that takes neither side |
| **Tasks: four projects, scattered** | Twenty-six Linear-style tasks from four projects on one board with no grouping, some blocked on each other, one duplicate, one overdue |
| **Ad ideas: spring launch** | Five people's ad ideas and reactions with very different instincts, dropped wherever they landed |

The debate board gives each side a Section instead. The tasks and ad-ideas
boards have no Sections at all: the mess is the point, and the first thing to
ask the host is to group what it sees (by project, by blocker chain, by
audience) and say what a person would miss. The three class boards give every student a Section of their own, which is what
makes per-student feedback legible: a comment lands on one person's work while
the rest of the class stays visible beside it. The graph board is the
handwriting case, so a watch on it returns a picture rather than a description.

Insert one, start `watch_board`, then use the board's **AI** action or the
selection toolbar's **Ask AI** button. The replies arrive as object comments.
The five Codex skills under [`.agents/skills`](../../.agents/skills/README.md)
each end with a scripted demo on one of these boards, with the exact prompts,
expected comments, and files to use.

## Optional second story

For group decisions, use the **Collective inquiry demo** template. Read selected
ideas, stage and approve an inquiry map, let participants vote with stamps, read
the aggregate vote, and stage a decision that preserves one minority concern.
This shows how human response changes the agent's next contribution.

For live problem coaching, select the exact saved items containing a student's
steps and ask the host to call `watch_board`. It follows
server-acknowledged changes for up to 15 minutes and prompts the agent to respond
after each saved step.

## Final recording checklist

- Public or unlisted YouTube video, under three minutes, with clear spoken audio.
- Public URL visible at least once.
- A visible WebMCP visual read and permission-bound write.
- The student's incorrect `-3`/`-1` claim is readable.
- The generated card visibly checks `x = -4` and asks for `(-4, -2)`.
- The feedback card is source-linked, synchronized, and undoable.
- The viewer write is visibly refused.
- The lesson video is visible as a shared canvas object.
- No invitation token, recovery link, email, key, or real student content is
  shown.
