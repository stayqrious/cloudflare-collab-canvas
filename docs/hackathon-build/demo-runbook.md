# WebMCP Challenge demo runbook

This recording script is designed for a public YouTube demo under three
minutes. Lead with the new teacher-scoped watch, show two different
interventions for two learners, and finish by proving that the agent remains a
collaborator under the teacher's authority.

## Before recording

1. Open [webmcp.spacescale.net](https://webmcp.spacescale.net/) in ChatGPT's
   in-app browser or another compatible WebMCP host.
2. Create a Space named **Live AI classroom**. Keep a second participant session
   visible and a viewer session ready for the permission proof.
3. Make two clearly labelled student regions:
   - **Needs a correction:** `x² + 7x + 10 = 0`, a hand-drawn graph that
     incorrectly marks roots at `-3` and `-1`, and a sticky saying “I think
     the roots are x = -3 and x = -1.”
   - **Finished early:** a correct factorization, `(x + 5)(x + 2) = 0`, and a
     sticky saying “Done — give me a harder one.”
4. Place a relevant public YouTube or Vimeo lesson card beside the first region
   and keep it paused.
5. Optionally prepare three short debate claims that state different assumptions
   so the close can briefly show an inquiry map.
6. Hide notifications, close unrelated tabs, set browser zoom to 100%, test the
   microphone, and rehearse once.

## Three-minute story

### 0:00–0:24 — the missing multi-user layer

Show the whole board, both learner regions, the lesson video, and the participant
avatars. Say:

> ChatGPT, Claude, and MCP already work brilliantly for individual tasks. The
> missing piece is putting that agent inside a live multi-user classroom while
> one teacher remains in control. SpaceScale gives the teacher's own agent a
> visible seat in the room.

Point out **WebMCP enabled**. Explain that the teacher can keep the lesson plan
and class notes in the host conversation; SpaceScale contributes the live board
state and classroom actions.

### 0:24–0:52 — the teacher chooses what the agent watches

Select all relevant saved steps across both learner regions. If a tighter shot
is clearer, marquee-select only one region first and say that selecting the
whole working set starts a board-wide watch.

Ask:

> Start watching these selected problem steps. Keep watching as the class works
> and respond through the board when a learner asks for help.

Show the **AI watching** indicator and say:

> The teacher chooses the whole working set or a selected region. The watch
> follows server-acknowledged saves for 15 minutes, and the agent stays connected
> through bounded WebMCP waits instead of scraping the page.

### 0:52–1:30 — one learner gets a concrete correction

Briefly select the equation and hand-drawn graph and ask:

> Inspect this selected visual. Check whether the plotted curve is consistent
> with the equation, and identify the first concrete issue.

Reselect the watched claim sticky. Choose **AI → Check my work** and add the note:

> Check x = -4 and give me one next step.

Show the AI-marked reply beside the work:

- calculation: `16 - 28 + 10 = -2`;
- prompt: **Can you plot (-4, -2) and use it to correct the curve?**

Say:

> The agent used the handwriting and spatial evidence, but it did not take over
> the solution. Its response is visibly AI-authored, attached to the student's
> saved step, synchronized to the other participant, and open to follow-up.

### 1:30–1:58 — an early finisher gets a different path

Select the watched **Finished early** sticky. Choose **AI → Ideate** or **AI →
Examples** and ask:

> Give this learner one genuinely harder quadratic that requires a different
> first move. Put it beside their work without solving it.

Show the new source-linked card appear in both sessions. Say:

> The same teacher-controlled agent sees a different learner and chooses a
> different intervention. A stuck student gets a smaller next step; an early
> finisher gets productive challenge.

Pan briefly to the video card:

> If the learner needs instruction first, Explain with a video lets the agent
> recommend what to watch for, and the confirmed lesson stays beside the work.

### 1:58–2:27 — collaboration with teacher-bound authority

Use the second participant session to react to or edit a permitted object and
show the first session update. Then switch to the viewer session and attempt an
AI write. Say:

> This is not a privileged classroom bot. The agent has exactly the permissions
> of the person who invited it. A viewer's agent remains read-only; an editor's
> agent cannot rewrite another person's work; the teacher directs the agent
> while the Worker enforces the shared-room rules.

Return to the owner session and undo the generated challenge card once.

### 2:27–2:45 — debates become inspectable structure

Pan to the prepared debate claims or inquiry map. Say:

> The same collaboration layer helps with class debate. It can make assumptions
> explicit, show exactly where students agree and disagree, and preserve an
> unresolved minority concern instead of inventing consensus.

If the debate board is not prepared, keep this as a spoken use case over the
two learner regions rather than adding another live tool call.

### 2:45–2:58 — close

End on the full board with both differentiated responses visible. Say:

> SpaceScale turns the teacher's own browser agent into a live classroom
> collaborator: watching the board, adapting support, and acting with the
> teacher's authority—not above it.

End on the product name and public URL.

## Recovery prompts

If the host does not choose the tools automatically:

- Visual reasoning: “Call `inspect_selected_board_visual` on my current
  selection and check the graph against the equation.”
- Start the watch: “Call `watch_selected_problem_steps` with action `start`
  on the saved text-bearing items I selected, then keep calling `wait`.”
- Watched-step reply: “Use `comment_on_watched_step` with the token, alias, and
  action from the watch result. Check x = -4 and ask the learner to plot the
  resulting point.”
- Correction card: “Call `read_selected_class_ideas`, then
  `add_collective_reasoning` in `counterexample_challenge` mode. Include a
  claim card and a counterexample card checking `x = -4`, connected with
  `checks`.”
- Early-finisher challenge: “Use the watch result's selection token with
  `add_thinking_expansion` or `add_idea_sensemaking`. Add one harder,
  source-linked problem and do not include its solution.”
- Capability discovery: “Call `list_class_collaboration_modes` and find the
  smallest mode for this learner's next step.”

If a write fails unexpectedly, confirm that the participant has edit access,
the selected items finished saving, and the watch or selection token came from
the same browser session.

## Alternate debate story

For a debate-focused recording, prepare claim stickies in which students
explicitly state their assumptions. Read the selected ideas, stage and approve a
collective inquiry map, let participants vote with stamps, read the aggregate
vote, and stage a decision that includes:

- the shared premise;
- the exact assumption on which the sides diverge;
- one point of genuine agreement;
- one unresolved disagreement or minority concern;
- the next claim the class should test.

This is the strongest secondary story after the live classroom watch because it
shows an agent improving collaboration without replacing the participants'
judgment.

## Final recording checklist

- Public or unlisted YouTube video, under three minutes, with clear spoken audio.
- Public URL visible at least once.
- The teacher visibly chooses a whole-board working set or selected region.
- The **AI watching** indicator and one board-side AI action are visible.
- Two learners receive visibly different interventions.
- The mistaken `-3`/`-1` claim and the `x = -4` correction are readable.
- Handwriting or a hand-drawn diagram is used as agent context.
- At least one AI response is synchronized to the second participant.
- The viewer write is visibly refused and a generated board card is undone.
- The shared lesson video is visible.
- No invitation token, recovery link, secret, or key appears in the recording.
