# SpaceScale WebMCP visual collaboration — implementation spec

## Outcome

SpaceScale gives an AI agent a visible, permission-aware place in a live
classroom canvas. The agent can work with selected typed ideas, handwriting,
sketches, saved problem steps, and aggregate votes; it can return source-linked
visual structures that every participant can inspect, edit, challenge, and
undo. Shared YouTube/Vimeo cards keep lesson media in the same collaborative
space. Crucially, the agent has no service identity: each WebMCP action runs as
the participant who authorized it and remains subject to that participant's
role, item ownership, section locks, and the authoritative server reducer.

One-line pitch:

> SpaceScale lets a class and an AI think together on one visual canvas, while every agent action inherits the permissions of the participant who invited it.

## Domain skills over a stable WebMCP substrate

The implementation separates domain reasoning from shared execution:

1. **Canvas substrate:** realtime objects, comments, sections, organisation
   templates, selection, undo, attribution, snapshots, and participant roles.
2. **WebMCP contract:** bounded reads, selected visual inspection, saved-step
   watches, structured inserts, server acknowledgement, and permission
   enforcement.
3. **Packaged skill:** prompts, decision rules, response shape, and the sequence
   in which the agent calls site tools.
4. **Optional external connector:** a separate MCP connection for live systems
   such as Linear, available to the same agent session and governed by that
   system's own authorization.

The current package is education-specific, but the collaboration substrate is
not limited to education. A domain conversion keeps layers 1 and 2 and replaces
the skill and board template:

| Skill package | Template/sections | Agent workflow |
| --- | --- | --- |
| `check-maths-steps` | Learner work regions, explanation resources, extension work | Watch saved steps, inspect diagrams, identify the first mistake, and ask a probing or scaffolding question without revealing the answer. |
| `marketing-brainstorm` | Brief, evidence, campaign angles, critique, experiments, owners | Watch contributions, cluster themes, challenge assumptions, preserve dissent, and create source-linked experiments. |
| `linear-planning` + Linear MCP | Backlog or status sections, assignee sections, blocked work | List issues, normalize them into visual cards, collaborate on ownership, and write confirmed assignments back through Linear. |

SpaceScale already stores templates as ordinary board-item batches and can share
organisation templates across Spaces. The skill therefore controls how the
agent interprets a watch and which structured writer it uses; the template
controls the starting layout. Neither changes the authorization boundary.
Skills normalize reasoning and orchestration, while the WebMCP schemas and
Worker continue to normalize and enforce every insert.

For Linear, the board is the planning surface rather than an accidental second
source of truth. Moving an issue card can represent a proposal; the skill must
ask for confirmation before calling a Linear mutation tool. The skill and the
SpaceScale page tools must also be available to the same agent session. The
repository currently ships the education implementation; the marketing and
Linear rows describe compatible extension packages, not bundled features.

## Why this is a strong WebMCP use case

- The agent and the class act on the same live canvas and signed-in session.
- Semantic tools handle typed ideas and votes; a bounded canonical visual surface handles the genuinely visual case of handwriting and sketches without a whole-board screenshot or brittle DOM automation.
- The most valuable context is ephemeral UI state: the teacher’s current selection and the class’s current aggregate vote.
- A bounded watch converts authoritative saved changes to selected problem steps into cancelable WebMCP long polls, letting the agent respond in the conversation as the reasoning develops.
- The AI is not a private tutor for each student. Its output becomes a shared object that students can challenge, vote on, revise, and undo.
- Human control is part of the product experience: selected-content consent is visible in SpaceScale, every write is teacher-requested through WebMCP, and the headline inquiry/decision flows add a second in-app preview.

## Authorization and authorship model

WebMCP registration happens inside the signed-in board page. Every writer gets
`canWrite` from the current participant session and submits its compiled
operation through the same `commitAndWait` function used by first-party canvas
edits. That function applies the local role/ownership check, writes the command
to the participant's durable outbox under their actor ID, queues the optimistic
model update, and sends the normal WebSocket commit. The tool reports success
only after the matching authoritative server action is received.

The Worker independently applies the same security boundary before reduction:

| Session role | Allowed mutation |
| --- | --- |
| Owner/co-owner | Any unlocked board content, including administrative canvas actions. |
| Editor | New editor-authored items, copies, and updates/deletes to that editor's own items only. |
| Viewer | No canvas mutation. |

No tool accepts an actor ID or role as input, so the model cannot select a more
powerful identity. Atomic batches fail before reduction if any child operation
is forbidden. Accepted objects use the authorizing participant's normal
attribution and keep an internal `assistedBy` marker for provenance.

## Implemented tool contract

### `list_class_collaboration_modes`

Returns the live collaboration catalog before the agent reads or changes the board.

- Lists all 27 available modes under their matching write tool.
- Explains the purpose and exact structural contract for each mode: entry count, source-alias cardinality, connection requirement, role vocabulary or required role groups, and decision-criteria count.
- Publishes the human-control contract: source linking, question-first critique, AI attribution, one-batch undo, blank student decision fields, no inferred consensus, and no grading or profiling.
- Reports Cross-Group Jigsaw as reserved—not live—and explains that it is waiting for authoritative section context.
- Reads no board or student data.

### `read_selected_class_ideas`

Reads saved sticky-note text from the current browser selection.

- Publicly discoverable and read-only.
- Returns selected text directly through the WebMCP host with no dedicated board UI.
- Returns ephemeral aliases such as `idea_1` plus an explicit `createdBy`
  display name and stable participant ID for action attribution; board and item
  IDs remain private.
- Deliberately does not inspect sections or infer group membership; the incoming section push owns that context.
- Does not return coordinates, sections, unselected content, presence, history, contact details, or authentication data.
- Returns an opaque selection token used by the next tool.

### Focused explanation and inspiration readers

`inspire_from_selected_ideas` and `explain_selected_ideas` expose
the same bounded selected-sticky snapshot with task-specific host guidance.
They are read-only and untrusted-content annotated, return no board positions or
unselected objects, and neither can mutate the canvas. Keeping these intents as
semantic tools gives the host a reliable contract instead of prompting against
the DOM.

### `inspect_selected_board_visual`

Makes the current browser's saved visual selection inspectable in the same live page for handwriting, sketches, arrows, shapes, spatial groupings, and mixed visual notes.

- Publicly discoverable and read-only; at most 40 selected saved items per inspection.
- Opens the isolated visual review directly from the authoritative saved selection.
- Renders the selected items through SpaceScale's canonical SVG exporter, preserving pencil paths, transforms, layout, typed context, and source ordering.
- Replaces stable item IDs with ephemeral aliases such as `visual_1`, returns each
  creator's display name and stable participant ID but no coordinates, and makes
  private board images non-pixel placeholders.
- Opens the result in an opaque modal review surface that covers the unselected board. Codex inspects this post-tool live-page state rather than receiving a large image string in JSON.
- Returns bounded metadata and explicit instructions to use identity only for attribution or clarification, mark uncertain handwriting as uncertain, avoid invention, and avoid grading, ranking, or profiling.
- Closing the review removes the temporary visual surface. It never changes the shared canvas.

### `watch_selected_problem_steps`

Follows changes to exact saved text-bearing items selected in the current browser
for 15 minutes so Codex can comment as a participant works through a problem.

- `start` snapshots at most 30 selected canvas-text, sticky-note, table, or Section-title items and returns ephemeral `step_N` aliases plus the authoritative board sequence.
- `wait` is a cancelable long poll, bounded to 20 seconds per call. It returns promptly when a selected item is saved, otherwise times out with the next cursor so the host can wait again.
- The tool tells the host to comment briefly after every changed step—checking the reasoning, acknowledging what is valid, identifying the first concrete issue or uncertainty, and asking one useful next-step question—then continue waiting.
- Only server-acknowledged changes enter the feed. Unsaved keystrokes, video embeds, unselected items, Section children, coordinates, presence, history, stable board/item/participant IDs, and contact or authentication data are excluded.
- `stop`, request cancellation, page navigation, or the fixed 15-minute expiry ends the watch. Sessions and up to 100 retained change groups live only in page memory.
- While a watch is live the board shows an **Ask AI** button in the selection toolbar. A participant's request (a watched step, one of `explain`, `ideate`, `critique`, `check_work`, `examples`, `explain_with_video`, and an optional 280-character note) is delivered as the next `wait` result with status `requested`, carrying the step text and a reply plan that names the exact next tool call. Up to 10 requests queue between polls; the oldest are dropped and counted. `nextSeq` is unchanged, so queued changes follow on the next wait.
- Replies go back to the board: `comment_on_watched_step` posts one object comment on a watched step (attributed to the participant, tagged as AI-written, at most 20 per watch), and every `start`, `changed`, `resync`, and `requested` result mints a fresh `selectionToken` over the watch's sticky-note steps, using the `idea_N` aliases the writers' schemas accept and reporting the `step_N` → `idea_N` mapping as `selectionSources`, so the `add_*` tools can insert cards without a second read call. Generative replies fall back to a comment when the browser cannot add items.

### Five education collaboration tools

These tools use a `selectionToken` and add ordinary board objects directly after the teacher permits the WebMCP write. They have no feature-specific UI. Every card links back to one to five approved source aliases, ends with a testable question, carries durable AI-assistance metadata, waits for authoritative save acknowledgement, and is undoable as one batch.

| Tool | Modes | Enforced collaboration invariant |
| --- | --- | --- |
| `add_thinking_expansion` | Gap Finder, Perspective Carousel, Idea Mashup, Constraint Shaker, Analogy Broker | Exactly two or three additions. Gap types and lenses must be explicit and diverse; Idea Mashup requires exactly two sources per addition; changed constraints and analogy domains must be named. |
| `add_idea_sensemaking` | Bridge Builder, Shared Glossary, Alternative Clusterer, Outlier Champion | One genuinely useful bridge, definition, or outlier is allowed instead of forcing filler. Every bridge cites at least two selected ideas; definitions and outliers use explicit roles; Alternative Clusterer requires exactly two organizations. |
| `add_collective_reasoning` | Evidence and Assumption Mapper, Productive-Tension Mapper, Counterexample Challenge, Uncertainty Annotator, Ethics and Consequences Map, Debate Cartographer | Every mode enforces its reasoning vocabulary and minimum structure. Maps require the relevant observation/claim/evidence/assumption, tension, counterexample, uncertainty state, stakeholder/consequence, or debate roles plus visible connections where relationships are essential. |
| `add_group_decision_scaffold` | Criteria Co-designer, Trade-off Visualizer, Assumption Auction, Consensus-with-Dissent, Minority Report, Decision Record | Each mode defines whether entries are criteria, options, assumptions, expressed concerns, or alternatives. Only Trade-off Visualizer accepts two to four class-selected criteria. Student weights, ratings, votes, responses, and final choice remain blank; silence is never consensus. |
| `add_learning_action_plan` | Idea-to-Experiment, Project Decomposer, Peer-Review Conductor, Teach-Back Listener, Thinking-Evolution Mirror, Process Replay | Experiments require prediction/evidence/test; projects require milestone/dependency/risk/open question; peer review requires feedback and synthesis without grading; teach-back separates clear points from clarification; evolution uses exactly three stages; replay links reasoning, decision, and turning points. |

### `add_content_visuals`

Adds one to three playful visual responses to the approved class discussion without introducing a feature-specific meme interface.

- Every visual cites one to five aliases from `read_selected_class_ideas`, includes a class discussion question, and is connected back to its source cards on the canvas. Alt text is optional; when omitted, the visual title is used as the image alt text.
- `meme_card` lets ChatGPT supply the joke, emoji, and palette while SpaceScale renders a deterministic 1200×675 raster locally.
- `inline_image` accepts an LLM-generated PNG, JPEG, WebP, or GIF only as an inline data URL. HTTPS URLs and SVG are rejected, so SpaceScale never hotlinks, expands CSP, or creates a server-side URL-fetch/SSRF path.
- Before upload, the browser decodes, bounds-checks, and re-encodes the raster through the existing privacy-safe image path. The existing private per-board R2 asset endpoint validates it again and addresses it by content hash.
- The request must explicitly confirm that the visual is classroom-safe, contains no real-student likeness, and targets no individual. The Images feature must be enabled by the Space owner.
- The stored image, caption, discussion prompt, and source connectors are AI-attributed and committed as one acknowledged, undoable realtime board batch.

### Shared lesson video

Video is a first-class collaborative canvas object rather than a link hidden in
chat. Participants add public YouTube or Vimeo URLs through the **Video** tool;
SpaceScale normalizes them to privacy-conscious player URLs and rejects other
hosts. The resulting card is persisted, selected, moved, copied, deleted,
exported, and synchronized under the same participant permissions as other
items. A pasted URL remains ordinary linked text unless the participant
explicitly chooses the video tool.

Video frames are intentionally excluded from the selected problem-step watch,
and the visual inspection boundary never sends private image pixels or an
unselected frame to the agent. This makes lesson media useful context on the
shared canvas without turning it into an implicit data-extraction surface.

### Section integration boundary

`cross_group_jigsaw` remains in the complete 28-mode domain catalog and board compiler tests, but no live tool currently accepts it. The selected-idea reader contains no section geometry or containment inference. When the tested section push lands, it can supply authoritative anonymous group context to a dedicated Jigsaw adapter without replacing or merging against the 27 non-section tools.

The writer-side adapter is already isolated behind the optional `sectionContext` provider:

- With no provider, `add_cross_group_jigsaw` is not registered, the capability catalog reports 27 live modes, and Jigsaw is marked reserved.
- The incoming section integration supplies a read-tool name and an in-memory token lookup. Its approved snapshot uses ephemeral `group_N` and `idea_N` aliases while retaining item IDs and versions only inside the page.
- With that provider present, the catalog reports 28 modes and registers `add_cross_group_jigsaw`. The writer requires agreement, tension, and complementary-idea roles; every card must cite at least two ideas from at least two authoritative groups; at least one comparison connection is required.
- The writer rejects inconsistent group/source mappings, expired or mismatched tokens, stale items, same-group-only comparisons, and any provider that does not use a valid WebMCP read-tool name. It never computes section membership from coordinates.

### `stage_collective_inquiry`

Turns a browser-selection token into two to four themes, source-to-theme connections, cross-theme bridges, one productive tension, and a next question.

- Validates every alias against the browser selection.
- Rejects duplicate alias assignments and stale/changed source items.
- The agent supplies meaning; SpaceScale computes deterministic layout and safe board operations.
- Opens a visual participant preview marked “no changes yet.”
- On approval, commits one ordinary `items.batch`, waits for server acknowledgement, selects the created objects, and reports success.
- Generated items retain internal `assistedBy` origin metadata, render with the
  responsible participant's ordinary initials, and carry a small AI mark so tool and
  human are always distinguishable.

### `read_live_class_vote`

Reads the one selected “Vote with stamps” table.

- Returns option labels, aggregate counts, total votes, leaders, and tie state.
- Returns no voter identity, actor ID, stamp ID, or inferred holdout.
- Explicitly instructs the agent not to treat a vote as proof of consensus.
- Returns a short-lived vote token.

### `stage_class_decision`

Uses a vote token to propose a chosen direction, rationale, minority concern, small pilot, success measure, and next open question.

- Requires an explicit `minorityConcern`; dissent cannot be silently omitted.
- Rejects stale vote counts and choices not present in the captured vote.
- Opens a visual teacher preview with aggregate vote bars.
- On approval, adds the vote evidence and decision cards in one acknowledged, realtime, undoable board batch.

## Human-agent sequence

1. Students add ideas to the shared Space.
2. The teacher selects the contributions that are in scope.
3. The agent can call `list_class_collaboration_modes` to choose the narrowest fitting move.
4. For typed stickies, the agent calls `read_selected_class_ideas`; for handwriting, sketches, or spatial reasoning, it calls `inspect_selected_board_visual`. SpaceScale shows the matching teacher consent preview.
5. The teacher can ask ChatGPT to call any of the five education-mode tools or `add_content_visuals`; the class receives a small, source-linked structure or visual to test, edit, discuss, or reject.
6. For the headline synthesis, the agent calls `stage_collective_inquiry`; SpaceScale shows a visual proposal preview.
7. The teacher approves; the map appears for every collaborator as one board update.
8. Students challenge the map and vote with stamps.
9. The agent calls `read_live_class_vote` on the selected vote table.
10. The agent calls `stage_class_decision`; the teacher reviews a decision that keeps a minority concern and next question visible.
11. The teacher approves; the whole class sees the decision record and can continue the inquiry.

For live problem coaching, the participant instead selects the exact working
steps and asks Codex to start `watch_selected_problem_steps`. Codex alternates
between bounded `wait` calls and short feedback until 15 minutes elapse or the
participant asks it to stop. While the watch is live the participant can also
select a step and press **Ask AI** on the board; the request arrives in the next
`wait` and Codex answers with a comment on that step or with cards.

## Architecture

- Registration uses the top-level JavaScript `document.modelContext.registerTool` API. The app remains fully functional when WebMCP is absent.
- Existing SpaceScale authentication, participant role and actor identity, item-ownership enforcement, Section locks, Durable Outbox, WebSocket commit path, history, and undo remain authoritative for UI and WebMCP actions alike.
- Text-selection, visual-inspection, vote receipts, and problem-step watch sessions live only in page memory. Snapshots are bounded to ten recent receipts; watches are bounded to five active sessions, 30 exact selected items, 100 retained relevant changes, and 15 minutes.
- Read tools expose bounded semantic data or one selected-only canonical SVG review surface. Mutation tools accept structured intent—not coordinates, raw board operations, or arbitrary HTML.
- Five generic education tools compile model-authored semantic cards, source aliases, roles, and relationships into deterministic layouts to the right of all current board content, so consecutive moves do not overlap. A complete mode-contract registry is shared by capability discovery and runtime validation, preventing the catalog and accepted inputs from drifting apart. The visual writer applies the same alias, freshness, placement, attribution, acknowledgement, and undo boundaries to private raster assets.
- Generated layout is compiled into protocol-valid ordinary board items and capped below the 100-operation batch limit.
- WebMCP commit promises resolve only after the corresponding authoritative server action; rejection or timeout reports failure.

## Safety constraints

- No grading, ranking, participation scoring, student profiling, or inferred ability.
- No whole-board or section reads. Visual inspection is limited to the saved items the teacher selected, with an opaque modal masking everything else.
- Problem-step watches include only exact text-bearing items selected at start, never expand Section contents, and report only authoritative saved changes rather than unsaved keystrokes.
- No autonomous or silent board edits: the teacher initiates and permits every WebMCP write, and can undo the whole batch.
- No identifying dissenters or claiming consensus.
- No AI-assigned priorities, weights, scores, votes, response counts, or final choices.
- No persistent AI memory about students.
- No prompts or selected content are sent to a new SpaceScale AI backend. Visual output is sanitized and stored only through the board's existing private image-asset path.
- All generated content is ordinary teacher-attributed board content and can be undone.

## Judging alignment

- **Usefulness:** supports the full classroom arc from divergent thinking through mutual understanding, collective reasoning, explicit decisions, experiments, and reflection.
- **Originality:** a capability-aware agent joins one shared class conversation, then leaves source-linked structures that students can challenge together instead of opening private AI chats.
- **Execution:** strict schemas, participant-scoped authorization, 27 live non-section modes plus one reserved section mode, selected-only handwriting inspection, shared video objects, deterministic non-overlapping layout, private raster sanitation/storage, atomic commits, server acknowledgement, realtime sync, provenance, and undo.
- **Thoughtful WebMCP:** uses live selection, authoritative saved-change cursors, canonical board rendering, and live vote state that an open page uniquely owns; it avoids whole-board screenshot guessing and needs no separate MCP installation.
- **Human-agent experience:** two genuine loops in which student response changes the agent’s second contribution and the teacher remains in control.

## Current verification gates

- Web TypeScript compiler passes.
- Production Vite build passes.
- Unit compiler tests cover all 28 catalog modes, including the reserved Jigsaw compiler path.
- Public WebMCP contract tests inspect every published requirement, execute all 27 currently live modes through their registered tools, verify acknowledged AI-attributed batches, and reject invalid role structures. A separate provider-enabled contract test proves the conditional 28th mode, acknowledged Jigsaw write, authoritative-group flags, and same-group rejection.
- Chromium exercises all fifteen registrations, the 15-minute watch capability contract, the selected-handwriting consent and masked review path, the published mode contracts and reserved-section boundary, three rejected unsafe structures, a representative write from each live education family, and a locally rendered/private-uploaded meme, then verifies save, AI attribution, and six independent undos.
- Full web TypeScript, Vite, unit, edge, protocol compatibility, lint, environment-doc, and secret-leak gates pass before production deployment.

Official implementation reference: [OpenAI Site tools / WebMCP](https://learn.chatgpt.com/docs/webmcp).
