# Board-side AI assist while a WebMCP watch is live — implementation plan

> Status: implemented. Steps 1–2d, 3–7 landed together; `grade` shipped as
> `check_work` per decision 2. Remaining items are listed under Step 8.

## Outcome

Today the only way a participant reaches the visiting agent is by typing in the
host's chat (Codex). This change adds a second, board-native entry point:

1. When the agent starts or continues `watch_board`, the tool
   call itself is the "ping". The page records that **this browser's** WebMCP
   state is `watching`.
2. While watching, an **AI** button appears in the selection toolbar. The
   participant selects a step and picks an action — Explain, Ideate, Critique,
   Check my work, Examples, Explain with a video — optionally with a short note.
3. The request is delivered to the agent as the result of its pending (or next)
   `wait` call, with the exact step text, the requested action, and per-action
   response guidance.
4. The agent answers **back on the board**: as an object comment on the step
   (new `comment_on_watched_step` tool over the existing comment system), or as
   inserted cards through the existing `add_*` education tools using a
   `selectionToken` the watch now issues. The host conversation stays available
   as a fallback when the participant cannot comment.
5. Everything the agent writes — cards, visuals, comments — carries
   `assistedBy` metadata and a small, consistent **AI** mark, so tool and
   human are always distinguishable at a glance and in exports.
6. `add_content_visuals` stops requiring alt text; the title is the fallback.
   This removes the slowest part of the visual-generation round trip.
7. Chat-driven WebMCP keeps working unchanged. The board button is an
   additional, more direct way to invoke the same watch.

## The constraint that shapes the design

WebMCP is pull-only. `document.modelContext.registerTool` lets the page answer
tool calls; it has no API for the page to message the agent unprompted. The one
moment the page can speak is when it resolves a tool call the agent is already
waiting on — which, during a watch, is the long-poll `wait` in
`apps/web/src/webmcp/problem-step-watch.ts`.

Consequences:

- The AI button is only meaningful while a watch session is live. Outside a
  watch there is no listener, so the button is hidden rather than disabled.
- A request submitted while no `wait` is pending (the agent is between polls,
  typically commenting on the previous change) is queued and delivered on the
  next `wait`, the same way board changes are queued today.
- The reply direction is different: the agent *can* write to the board, because
  writing is an ordinary tool call the agent initiates. Two paths already exist
  and are reused rather than rebuilt (see "Reply channels" below).

## Watch state machine (per browser)

```
idle ──start──▶ watching ──wait pending──▶ listening
  ▲                │  ▲                        │
  │                │  └──── wait resolved ─────┘
  └── stop / expire / replaced / page unload
```

- `idle`: no live session. No AI button.
- `watching`: a session exists and has not expired; the agent is between polls.
  AI button visible; requests queue.
- `listening`: a `wait` is pending. AI button visible; a request resolves the
  pending wait immediately.

The UI treats `watching` and `listening` identically (button visible); the
distinction only matters for delivery. Expose both so the indicator can say
"AI is listening" vs "AI is watching · 12:40 left" if wanted later.

## Design decisions

### 1. Which items can be sent — watched steps only (v1)

The watch contract promises the agent sees only "the exact saved text items
selected when the watch started". A request therefore must reference items in
`session.itemIds`. In the toolbar this means:

- AI button enabled when the current selection is non-empty and every selected
  id is a watched item; the request carries those aliases.
- With no selection, the button offers "all watched steps".
- If the selection includes unwatched items, the button is disabled with the
  title "Only steps in the current AI watch can be sent. Start a new watch to
  include this item." The agent-side `start` already replaces older sessions,
  so a participant can re-select and ask the agent to restart.

Deferred: an "extend watch" action that snapshots a newly selected item and
reports it as `change: "added"`. It is cheap to add later but changes the
tool contract text, so keep it out of v1.

### 2. Action catalog

| `action`             | Toolbar label          | Response guidance (summary)                                                                                                        |
| -------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `explain`            | Explain                | Plain-language explanation of the step, define terms, preserve notation, separate explicit claims from interpretation.             |
| `ideate`             | Ideate                 | Several genuinely different next moves or framings grounded in the step; at least one unexpected connection and one open question. |
| `critique`           | Critique               | Acknowledge what is valid, then the first specific issue or unstated assumption; ask one next-step question. No solving ahead.     |
| `check_work`         | Check my work          | Verify the reasoning step by step; name the first error if any, say what is correct, do not assign a score or level.               |
| `examples`           | Examples               | Two or three worked examples of the same idea at similar difficulty, with one deliberately different surface form.                 |
| `explain_with_video` | Explain with a video   | Suggest what kind of short video would help and what to watch for; propose a specific title or search only if confident it exists. |

**Flag — `grade`:** the request list included "grade". Every existing tool
result carries `avoid: "Do not grade, profile, rank, or infer ability…"` and
`docs/classroom-ai-safety.md` names grading as prohibited. Shipping a Grade
button contradicts both. This plan uses `check_work` (formative verification,
no score) in its place. If a teacher-facing grading mode is wanted, it needs a
policy change first and would be gated on role, not added to the participant
toolbar. Decision needed before step 3 below; nothing else depends on it.

`explain_with_video` is guidance only: the agent describes or recommends a
video in its reply. Adding a video embed to the board remains a separate,
participant-confirmed write.

### 2b. Reply channels — what already exists and what is missing

| Channel                       | Exists today                                                                                                                                                                                                                                     | Gap for this feature                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Comment on the step**       | Per-item object comments: `ApiClient.createComment` (`apps/web/src/transport/api.ts:318`), edge route `POST /comments` with a 2,000-code-point limit (`apps/edge/src/board-room.ts:444`, `:6551`), `canComment()` role gating, MathJax rendering, `server.comments.refresh` broadcast so every client redraws. | No WebMCP tool can post a comment. Add `comment_on_watched_step` (step 2b below). Comments have no writer metadata; decision 4b adds `assistedBy`/`assistance` and a visible tag.             |
| **Insert cards near the work** | `add_thinking_expansion`, `add_idea_sensemaking`, `add_collective_reasoning`, `add_learning_action_plan`, `add_group_decision_scaffold`, `add_content_visuals`, `stage_collective_inquiry`. All resolve `sourceAliases` by name against a `CollectiveInquirySnapshot` looked up by `selectionToken` and version-check every source (`education-partner.ts:955-1005`). | Only `read_selected_class_ideas` mints tokens, and only for sticky notes. The watch should mint a compatible token for its sticky steps so the agent can insert without a second read call. |
| **Host conversation**         | Every `wait` result already tells the agent to comment in the conversation.                                                                                                                                                                        | Keep as fallback; the result now says which channel to prefer.                                                                                                                              |

Per-action default channel, carried in `responseGuidance.replyVia`:

| Action                                                   | Preferred reply                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `explain`, `critique`, `check_work`, `explain_with_video` | `comment` on the requested step (one comment, ≤ 2,000 chars, MathJax allowed). Falls back to `conversation`. |
| `ideate`, `examples`                                     | `board` via `add_thinking_expansion` / `add_idea_sensemaking` with the issued `selectionToken`, or `comment` when the step is not a sticky note. |

Why a comment and not a new sticky for the explanatory actions: a comment is
anchored to the step, does not shift layout, is resolvable by the participant,
and is exactly what the safety doc allows ("confirmed output is ordinary board
content"). The card tools place output to the right of all board content, which
suits new ideas but not an answer to "explain step 2".

### 4b. Everything AI-written is tagged and visibly marked — decided

Two facts are recorded on every AI-written object, and both are visible:

- **Accountable participant** — the existing `author` on comments and
  `createdBy` on items. For AI-written content this is the participant whose
  browser ran the tool. Unchanged.
- **Writer** — whether a person wrote it or the visiting agent did, and for
  the agent, which tool and which requested action.

**What already exists for items.** `BoardItemBase.assistedBy?: "ai"`
(`packages/protocol/src/index.ts:206-213, 333`) is validated by
`normalizeBoardItem`, round-tripped by board-core (`index.ts:1310`), typed on
the edge (`apps/edge/src/types.ts:211`), and set on **every** item the write
tools create through `createItem` in `apps/web/src/activities/batch.ts:12`.
So tracking for items is done; only the visible mark is missing, and it is
missing on purpose: `renderer.test.ts:465` ("keeps the responsible author's
normal badge for assisted content") asserts that no `creator-badge-ai` class
is rendered. That test flips.

**One vocabulary for items and comments.** Comments reuse the same field
rather than inventing `origin`:

```ts
// packages/protocol (shared by web and edge)
export const ITEM_ASSISTANCE = ["ai"] as const;              // exists
export type Assistance = { tool: string; action?: AssistAction }; // new

// apps/web/src/types.ts
export type BoardComment = {
  …existing fields…
  assistedBy?: "ai";
  assistance?: Assistance;   // present iff assistedBy === "ai"
};
```

Storage for comments, three columns:

| Column              | Type                                                                | Set by                                        |
| ------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `assisted_by`       | `TEXT CHECK (assisted_by IS NULL OR assisted_by = 'ai')`            | `POST /comments` body; NULL for typed comments |
| `assistance_tool`   | `TEXT CHECK (… length BETWEEN 1 AND 64)`                            | required when `assisted_by = 'ai'`             |
| `assistance_action` | `TEXT` (one of `ASSIST_ACTIONS`)                                    | optional when `assisted_by = 'ai'`             |

`stepAlias` is returned to the agent but **not stored** — aliases are
per-watch and meaningless after the session ends.

**The mark — one small "AI" glyph, everywhere assisted content appears:**

| Surface                                | Mark                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas item with a creator badge (sticky, image, stamp) | The existing initials badge gains class `creator-badge-ai`: a second, smaller circle overlapping its top-left reading "AI" in 6–7 px bold, same white stroke. `<title>` becomes "Created by {name} with AI assistance". |
| Canvas item without a creator badge (text, table, zone, shape, line, pencil, video) | A standalone `assistance-mark` group at the top-right of the item's local bounds: 14 px pill, "AI" text, `pointer-events="none"`, `aria-hidden`; the node's `aria-description` carries the same sentence. |
| Comment card in the drawer             | Pill after the author name: **"AI · Critique"** (action label when known, else "AI"), `title="Written by the AI assistant through {tool} on behalf of {author}"`. Typed comments get nothing, so existing comments look as they do today. |
| Canvas comment marker                  | Unchanged; the drawer carries the detail.                                                                                                                                  |
| Attributed export (`export.attributed.json`) | Items already carry `assistedBy`; verify the export projects it and add it if the projection is explicit. Comments are not exported today (follow-up).                |
| SVG export                              | No creator badges are exported today, so no AI mark either — consistent. Follow-up if wanted.                                                                              |

Sizing rule: the mark must be smaller than the initials badge (radius 9) and
never overlap text, so it uses the same corner anchoring and clamps to a
minimum 6 px glyph. It is decorative; the accessible name lives in
`<title>`/`aria-description`.

**Policy change.** README, `spec.md`, and `docs/classroom-ai-safety.md` all
say assisted content renders "with no AI-specific board label". That rule is
reversed by this plan: every AI-written item and comment shows a small,
consistent AI mark so a reader can always tell tool from human. Step 7 rewrites
those sentences. The other half of the rule — attribution to the responsible
participant, never to a synthetic AI actor — stays exactly as it is.

### 3. Optional note

A free-text note (max 280 chars, trimmed, `requiredText`-style validation) lets
the participant say "I don't get why the sign flips". It is marked untrusted
content like step text. Empty notes are omitted from the result.

### 4. Per-browser state, not presence (v1)

"That particular user's MCP state" is naturally per browser: watch sessions
live only in page memory. v1 keeps the state local to `BoardApp`. Broadcasting
it through presence (so a teacher sees who has AI watching) is listed as an
optional follow-up because it touches the protocol (`ClientPresenceFrame` in
`packages/protocol/src/index.ts`, edge validation, `Presence` in
`apps/web/src/types.ts`) and the safety doc currently excludes presence data
from the AI boundary.

### 5. Delivery semantics

- New wait result `status: "requested"`, listed alongside `changed`,
  `timeout`, `resync`, `stopped`, `expired`, `replaced`. It is non-terminal:
  `continueWatching: true`.
- Requests live in `session.requests`, capped at 10 (oldest dropped, count
  reported as `droppedRequests`). Their steps are re-read at delivery so a
  request queued before an edit carries the current text, matching the
  selection token minted in the same result; deleted steps are flagged. They are consumed when a result carrying
  them resolves; a wait rejected by abort before resolution leaves them queued.
- Precedence in `wait`: resync → requests → changes → long poll. Requests are
  self-contained (they embed the current text of the referenced steps), so
  `nextSeq` is unchanged and any queued changes arrive on the following wait.
- A request received while a wait is pending resolves that wait immediately.
- Requests are rejected (throw, surfaced as a toast) when there is no live
  session, when any referenced id is not watched, or when the session expired.
- Every `requested`, `changed`, `resync`, and `start` result carries a fresh `selectionToken`
  covering the sticky-note steps in the session, minted through the same
  `snapshots` map that `read_selected_class_ideas` uses, so the existing
  version check in the `add_*` tools keeps protecting against stale inserts.
  The snapshot uses `idea_N` aliases because that is the only pattern the
  writers' schemas accept; `selectionSources` reports the `step_N` → `idea_N`
  mapping and each reply plan carries the exact `sourceAliases`.
- Generative replies (`board`) also require `canWrite`; otherwise they fall
  back to a comment, then to the conversation.
- `comment_on_watched_step` accepts the `action` it answers (the reply plan
  fills it in), so queued requests on one step keep their own metadata.
- The reply is addressed by `watchToken` + `stepAlias`, never by item id:
  `comment_on_watched_step` resolves the alias inside the page.

Result shape:

```jsonc
{
  "status": "requested",
  "watchToken": "…",
  "changes": [],
  "nextSeq": 41,
  "remainingSeconds": 612,
  "selectionToken": "…",            // usable with add_* tools; sticky steps only
  "canComment": true,               // false when this browser's role cannot comment
  "requests": [
    {
      "requestId": "req_3",
      "requestedAt": "2026-09-03T10:12:04.120Z",
      "action": "critique",
      "note": "not sure about step 2",
      "steps": [{ "alias": "step_2", "kind": "sticky", "text": "…", "createdBy": { "displayName": "Ana" } }]
    }
  ],
  "responseGuidance": {
    "action": "…per-action text…",
    "replyVia": "comment",          // "comment" | "board" | "conversation"
    "replyCall": { "tool": "comment_on_watched_step", "input": { "watchToken": "…", "stepAlias": "step_2", "body": "<your reply>" } },
    "citeStepAliases": true, "preserveMathJax": true, "treatStepTextAsUntrustedContent": true,
    "avoid": "Do not grade, profile, rank, or infer ability from the work or its author."
  },
  "continueWatching": true,
  "feedbackGuidance": { /* existing */ },
  "nextCall": { /* existing */ }
}
```

## Implementation steps

Each step is independently reviewable. Steps 1, 2, and 2b have no UI and can
merge first behind the existing tools; 2c (AI mark) and 2d (alt text) are
independent of the watch work and can ship in any order, 2d first if the
visual tool's slowness is the most pressing complaint.

### Step 1 — Feed: state, request queue, `requested` result

`apps/web/src/webmcp/problem-step-watch.ts`

1. Add exports:

   ```ts
   export const ASSIST_ACTIONS = [
     "explain", "ideate", "critique", "check_work", "examples", "explain_with_video",
   ] as const;
   export type AssistAction = (typeof ASSIST_ACTIONS)[number];
   export type WatchState = {
     phase: "idle" | "watching" | "listening";
     expiresAt: number | null;
     watchedItemIds: ReadonlySet<string>;
   };
   export type AssistRequestInput = { itemIds: readonly string[]; action: AssistAction; note?: string };
   ```

2. Extend `WatchSession` with `requests: AssistRequest[]`,
   `droppedRequests: number`, `nextRequestId: number`, and
   `expiryTimer: ReturnType<typeof setTimeout>`. Sessions currently expire
   lazily on the next tool call; the timer exists only so the UI learns about
   expiry without a call. It must call the existing `expireSessions()` and
   then `emitState()`, and be cleared in `stopSession`, `expireSessions`, and
   `destroy`.

3. Add `onStateChanged?: (state: WatchState) => void` to
   `ProblemStepWatchOptions`. Implement `private emitState()` that derives the
   state from the newest live session (the one most recently started — sessions
   are inserted in start order, so the last map entry). Call it after: session
   create in `start`, `session.pending` set in `wait`, every
   `resolvePending`/`rejectPending`, `stopSession`, `expireSessions` when it
   removed something, `recordAuthoritativeReload` (pending resolved), and
   `destroy`. Expose `getState(): WatchState` for the initial render.

4. Add the public entry point:

   ```ts
   requestAssistance(input: AssistRequestInput): { requestId: string; delivered: boolean }
   ```

   - Throws `"Ask the agent to start a problem-step watch first."` when no live
     session exists (after `expireSessions()`).
   - Targets the newest live session.
   - Validates `action` with `enumValue`, `note` with `optionalText(…, 280)`,
     and that every `itemId` is in `session.itemIds` (throw
     `"Only steps in the current AI watch can be sent."`). Empty `itemIds`
     means every watched step.
   - Builds `steps` from `session.steps` (already alias-only, display-name-only),
     pushes the request, trims to 10 while incrementing `droppedRequests`.
   - If `session.pending` exists, `resolvePending(session, this.requestedResult(session))`
     and return `delivered: true`; otherwise `delivered: false`.

5. In `wait`, after the `needsResync` branch and after `afterSeq`/`waitMs`
   validation, add:

   ```ts
   if (session.requests.length > 0) return Promise.resolve(this.requestedResult(session));
   ```

   `requestedResult` splices `session.requests` (consume-on-deliver), resets
   `droppedRequests`, and returns the shape above with
   `...watchGuidance(session.token, session.lastReportedSeq)`. Per-action
   guidance comes from a `const ASSIST_GUIDANCE: Record<AssistAction, string>`
   table mirroring the action catalog.

6. In `recordAuthoritativeAction`, a change arriving while requests are queued
   behaves as today (it may resolve a pending wait with `changed`); the
   requests then go out on the next wait. No change needed, but add a test.

### Step 2 — Tool surface and passthrough

`apps/web/src/webmcp/collective-inquiry.ts`

1. Pass `onStateChanged` through `CollectiveInquiryWebMcpOptions` into the
   feed; add `requestAssistance(input)` and `getWatchState()` passthroughs
   next to `recordAuthoritativeReload`.
2. Update the `PROBLEM_STEP_WATCH_TOOL` description: add `requested` to the
   status list; add one sentence — "While a watch is live the participant can
   also send a request from the board's AI button; a `requested` result names
   the step aliases, the requested action, and an optional note. Respond to
   that action in the conversation, then call wait again." Keep it in the
   same single template string so the existing test that checks the status
   list keeps passing (extend the test).
3. `apps/web/src/webmcp/education-partner.ts` publishes the watch in
   `list_class_collaboration_modes` (around line 742). Add
   `participantRequests: { actions: ASSIST_ACTIONS, deliveredVia: "wait status requested", replyTools: ["comment_on_watched_step", "add_thinking_expansion", "add_idea_sensemaking"] }`
   so hosts discover the affordance from the catalog.

### Step 2b — Reply channels

**Selection token from the watch** (`collective-inquiry.ts`, `problem-step-watch.ts`)

1. Give the feed a `mintSelectionToken?: (sources: CollectiveInquirySnapshot["sources"]) => string`
   option. `CollectiveInquiryWebMcp` implements it by building the snapshot,
   storing it in `this.snapshots`, and calling `trimSnapshots`. Raise
   `MAX_SNAPSHOTS` from 10 to 20 so request-minted tokens do not evict a token
   the participant's chat flow is about to use.
2. In `start` and `requestedResult`, mint a token from the session's sticky
   steps (alias `step_N`, current `version` from `getAuthoritativeItem`). Omit
   `selectionToken` when the session has no sticky steps and say so in
   `responseGuidance`.
3. No change to the `add_*` tools: `resolveSources` already matches by alias and
   `snapshot()` already rejects stale versions.

**`comment_on_watched_step` tool** (`collective-inquiry.ts`)

4. Options added to `CollectiveInquiryWebMcpOptions`:
   `canComment: () => boolean` and
   `createComment: (itemId: string, body: string, assistance: Assistance) => Promise<void>`.
   In `app.ts` wire them to `this.canComment()` and to a new
   `commentFromWebMcp(itemId, body, assistance)` that calls
   `this.api.createComment(boardId, itemId, body, assistance)`, upserts into
   `this.comments`, and calls `applyCommentChange()` — the same three lines
   `submitComment` runs after its own request (line ~5567). `submitComment`
   itself keeps calling `createComment` without assistance, so typed comments
   are stored with `assisted_by = NULL`.
5. Register the tool:

   ```ts
   {
     name: "comment_on_watched_step",
     description: `Post one object comment on a step of a live problem-step watch, as the participant's reply channel for explain, critique, check_work, and explain_with_video requests. Pass the watchToken and the step alias from the requested result. The comment is attributed to this browser's participant, renders MathJax, is limited to 2000 characters, and can be resolved by the class like any other comment. Use it only to answer a requested action or a changed step; never to grade or label the participant. ${WEBMCP_MATHJAX_GUIDANCE}`,
     inputSchema: { type: "object", properties: { watchToken: {…}, stepAlias: { type: "string", pattern: "^step_[0-9]{1,3}$" }, body: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["watchToken", "stepAlias", "body"], additionalProperties: false },
     annotations: { readOnlyHint: false, untrustedContentHint: true },
     execute: (input, { signal }) => this.commentOnWatchedStep(input, signal),
   }
   ```

   `commentOnWatchedStep`: validate with `requiredText(body, "body", 2000)`
   (the edge counts code points; mirror `[...body].length`), resolve
   `watchToken` + `stepAlias` → `itemId` via a new
   `ProblemStepWatchFeed.resolveStep(token, alias)` that throws the same
   "missing or expired" message as `execute`, check `canComment()` (throw
   "This browser cannot comment on this Space."), call `createComment` with
   `assistance: { tool: "comment_on_watched_step", action }`
   where `action` is the most recent requested action for that alias if one is
   pending or was delivered in the last result, else omitted. Return
   `{ status: "commented", stepAlias, characters, writtenBy: "webmcp", onBehalfOf: { displayName }, privacy: "…" }`.
   Rate-limit to one in flight per session and at most 20 comments per watch,
   so a looping host cannot flood the 10,000-comment board cap.
6. **Edge — writer metadata on comments** (`apps/edge/src/migrations.ts`, `board-room.ts`):
   - Board migration `version: 14, name: "comment_assistance"`:
     ```sql
     ALTER TABLE comments ADD COLUMN assisted_by TEXT
       CHECK (assisted_by IS NULL OR assisted_by = 'ai');
     ALTER TABLE comments ADD COLUMN assistance_tool TEXT
       CHECK (assistance_tool IS NULL OR (length(assistance_tool) BETWEEN 1 AND 64));
     ALTER TABLE comments ADD COLUMN assistance_action TEXT
       CHECK (assistance_action IS NULL OR length(assistance_action) <= 32);
     ```
     Existing rows read back as typed comments (all three NULL).
   - `CommentRow` gains the three columns. Check the `readComment` /
     `listComments` SELECTs project them (they join `members` for
     `author_name`; add the columns explicitly if the select is not `c.*`).
   - `createComment`: `assertExactKeys(body, ["itemId", "body"], ["itemId", "body", "assistedBy", "assistance"])`;
     new `requireCommentAssistance(body)` accepts either nothing, or
     `assistedBy: "ai"` (validated against `ITEM_ASSISTANCE` from
     `@collab/protocol`) with `assistance.tool` against
     `^[a-z][a-z0-9_]{0,63}$` and optional `assistance.action` against
     `ASSIST_ACTIONS` (move the enum into `@collab/protocol` so web and edge
     cannot drift). `assistance` without `assistedBy`, or vice versa, is 400.
   - `commentFromRow` emits `assistedBy`/`assistance` only when set; a row
     with `assisted_by = 'ai'` and `assistance_tool IS NULL` is invalid stored
     data, same as the existing resolved/resolver consistency check.
   - Comments are not part of `export.json` / `export.attributed.json` today,
     so no export change; follow-up if comment export is wanted.
7. **Web — comment type, parser, drawer** (`types.ts`, `transport/api.ts`, `ui/app.ts`, `styles.css`):
   - `BoardComment.assistedBy?: "ai"`, `assistance?: Assistance`;
     `parseBoardComment` passes both through when present and validates the
     pair (so an edge that has not migrated yet still parses).
   - `ApiClient.createComment(boardId, itemId, body, assistance?)` sends
     `assistedBy: "ai"` plus `assistance` only when provided.
   - `renderComments` (line ~5655, where `author.textContent` is set): after
     the author `<strong>`, append
     `<span class="assistance-tag" title="…">AI · Critique</span>` for
     assisted comments. Label: action → the toolbar label from the action
     catalog; no action → "AI".
   - CSS: `.assistance-tag` as a small pill matching `.comment-state`; add it
     after the existing `.comment-*` rules to keep specificity lint clean.
   - `CommentStore.upsert`/`reconcile` need no change; the fields are inert.

### Step 2c — The AI mark on every assisted board item

`apps/web/src/board/renderer.ts`

1. `creatorBadge(item, displayName)` (line ~1741): when
   `item.assistedBy === "ai"`, add class `creator-badge-ai` and append a
   second circle + text at `(x - radius * 0.9, y - radius * 0.9)` with radius
   `max(5, radius * 0.6)`, fill `#2d2240`, white stroke 1.5, text "AI" at
   `font-size max(6, radius * 0.6)`, weight 800. Same `pointer-events="none"`.
2. `appendCreatorAttribution` (line ~1728): label becomes
   `Created by {name} with AI assistance` when assisted. Also set
   `node.dataset.assistedBy = "ai"` so Playwright and CSS can target it.
3. New `assistanceMark(item)` for kinds that get no creator badge. Anchor at
   the top-right of the item's local geometry (`x + width - 10, y + 4` for
   boxed kinds; for `line`/`pencil` use the max-x/min-y of their points;
   for `zone` the title bar's right end). A 14 × 10 rounded rect with "AI"
   text, class `assistance-mark`, `aria-hidden`, `pointer-events="none"`.
   Append it from `itemNode` whenever `item.assistedBy === "ai"` and no
   creator badge was added.
4. `reuseItemNode` / `updateVideoEmbedNode` paths must not lose the mark:
   `assistedBy` is immutable after create, so a reused node keeps it — add a
   test that a re-render of an assisted item still has one mark, not two.
5. `styles.css`: `.assistance-mark`, `.creator-badge-ai` (no colour changes to
   the initials circle itself). The mark is decorative and scales with the
   canvas like the initials badge does.
6. `renderer.test.ts:465`: flip the assertion to expect `creator-badge-ai` and
   the "AI" text, keep the initials assertion ("CM" still present). Add a
   case per un-badged kind (text, table, zone, shape, line, pencil) asserting
   exactly one `assistance-mark`.
7. Edge attributed export (`board-room.ts`, `attributedExportObject`): confirm
   items are emitted whole (then `assistedBy` is already there) or add the
   field to the projection. Test: an assisted sticky exports with
   `assistedBy: "ai"`.

Nothing changes in the write tools or in `activities/batch.ts` — every
generated item is already tagged.

### Step 2d — Alt text becomes optional for generated visuals

`alt` is already optional on image geometry
(`packages/geometry/src/index.ts:172, 787`) and in the upload dialog
("Alt text *optional*", `app.ts:1723`). Only `add_content_visuals` forces it,
and the agent spends a full generation pass writing 500-character
descriptions for every meme.

`apps/web/src/webmcp/education-partner.ts`

1. `contentVisualsToolSchema()` (line ~1019): keep the `altText` property but
   drop it from both `required` lists (lines ~1077 and ~1102). Description
   becomes "Optional. Describe meaningful visual content and visible words; if
   omitted the title is used."
2. `parseContentVisuals` (line ~1393): `altText: optionalText(entry.altText, …, 500)`.
3. Tool description (line ~621): replace "include accessible alt text and a
   discussion question" with "include a discussion question; alt text is
   optional".
4. `apps/web/src/activities/education-partner.ts:111, 533`: `altText?: string`
   and `alt: visual.altText ?? visual.title`. The title is already required
   (1–60 chars) and is the same words a screen reader would want, so
   accessibility does not regress to an empty `alt`.
5. Tests: `webmcp/education-partner.test.ts:167, 218` and
   `activities/education-partner.test.ts` — add a case with `altText` omitted
   asserting the image item's `alt` equals the title; keep one case with
   explicit `altText`. Playwright `webmcp-collective-inquiry.spec.ts:424`:
   drop `altText` from one visual.
6. `list_class_collaboration_modes` catalog entry for the visual tool: mark
   `altText` optional so hosts stop generating it.

**Guidance** (`problem-step-watch.ts`)

7. `ASSIST_GUIDANCE` becomes `Record<AssistAction, { action: string; replyVia: "comment" | "board" | "conversation" }>`.
   `requestedResult` fills `replyCall` for `comment` (with the first requested
   alias) and for `board` (tool `add_thinking_expansion`, `selectionToken`,
   `sourceAliases`). When `canComment` is false, `replyVia` downgrades to
   `conversation` and `replyCall` is omitted.
8. The existing `feedbackGuidance.action` for `changed` results keeps
   "comment briefly in the conversation" — no behaviour change for ordinary
   step edits unless the participant asked for something.

### Step 3 — Board UI

`apps/web/src/ui/app.ts`

1. State: `private aiWatchState: WatchState = { phase: "idle", expiresAt: null, watchedItemIds: new Set() }`.
   In the `CollectiveInquiryWebMcp` constructor call (line ~1319) pass
   `onStateChanged: (state) => this.setAiWatchState(state)`.
   `setAiWatchState` stores the state, toggles the topbar indicator, and calls
   `this.updateSelectionActions(this.tools.selection)` so the button re-evaluates.

2. Markup in `.selection-actions` (line ~1566), placed before Comment so it is
   the first action on a selected step:

   ```html
   <div class="selection-ai-wrap" data-selection-ai-wrap hidden>
     <button type="button" data-selection-ai aria-label="Ask AI about the selection" aria-haspopup="menu" aria-controls="ai-assist-menu" aria-expanded="false">AI</button>
     <div class="floating-menu ai-assist-menu" data-testid="ai-assist-menu" id="ai-assist-menu" role="menu" aria-label="Ask AI" hidden>
       <p class="menu-eyebrow" data-ai-assist-scope>1 selected step</p>
       <button type="button" role="menuitem" data-ai-action="explain">Explain</button>
       <!-- one button per ASSIST_ACTIONS entry, labels from a small table -->
       <label class="ai-assist-note"><span>Add a note (optional)</span><input type="text" maxlength="280" data-ai-assist-note /></label>
       <p class="ai-assist-menu-note">Your request and the selected step text go to the AI assistant already watching this Space. Answers appear in its chat.</p>
     </div>
   </div>
   ```

   Generate the action buttons from `ASSIST_ACTIONS` so the UI cannot drift
   from the feed's enum.

3. Behaviour, following the arrange-menu pattern (`setArrangeMenuOpen`,
   line ~2669 wiring): `setAiAssistMenuOpen(open)`, close on outside click,
   Escape, and on selection change (line ~2403 already closes arrange).
   Clicking an action:

   ```ts
   const result = this.webMcp?.requestAssistance({
     itemIds: [...this.tools.selection],
     action,
     note: noteInput.value.trim() || undefined,
   });
   this.notify(result?.delivered
     ? `Sent to the AI assistant: ${label}.`
     : `Queued for the AI assistant: ${label}. It will see it on its next check.`, "info");
   ```

   Wrap in try/catch and `notify(error.message, "warning")` — the feed's
   messages are already participant-facing.

4. In `updateSelectionActions` (line ~6180): compute
   `const watching = this.aiWatchState.phase !== "idle"`;
   `wrap.hidden = !watching`; `button.disabled = !allSelectedAuthoritative || !selectedIds.every((id) => watchedItemIds.has(id))`;
   set the title from decision 1; update `data-ai-assist-scope` text
   ("All 3 watched steps" when selection is empty, "2 selected steps" otherwise).
   Close the menu when the button becomes hidden or disabled.

5. Topbar indicator (small, non-persistent — it disappears when the watch
   ends, so it stays within the safety doc's "no persistent AI-specific
   chrome"): a `<span class="ai-watch-indicator" data-ai-watch-indicator role="status" hidden>`
   next to the save status showing "AI watching · 12:40 left". Refresh the
   countdown with a 30 s interval only while non-idle. Clicking it does nothing
   in v1.

6. Teardown: nothing extra — `destroy()` on the feed emits `idle`, which hides
   the button and indicator.

### Step 4 — Styles

`apps/web/src/styles.css`: `.selection-ai-wrap` mirrors
`.selection-arrange-wrap` (line 1170); `.ai-assist-menu` mirrors
`.arrange-menu` (line 1232) plus the note input and helper text. Keep every
new rule after the shared `.floating-menu` rules so `noDescendingSpecificity`
stays quiet (the lint reached zero warnings in PR #8; keep it there).
`.ai-watch-indicator` reuses the `.save-status` pill styling.

### Step 5 — Unit tests

`apps/web/src/webmcp/problem-step-watch.test.ts` (extend the existing
fixtures):

- State transitions: `idle` → `watching` on start → `listening` on wait →
  `watching` on resolve → `idle` on stop, expire (fake timers), replace,
  destroy, and reload-with-pending. `getState()` matches the last emitted.
- Request with a pending wait resolves it with `status: "requested"`, correct
  aliases/text/action/note, `nextSeq` unchanged, `continueWatching: true`.
- Request with no pending wait is queued; next `wait` returns it before any
  queued `changed` result; the following `wait` returns the change.
- Requests capped at 10 with `droppedRequests`.
- Rejections: no session, unwatched id, bad action, note over 280 chars,
  expired session (advance fake timers past 15 min).
- Abort of a pending wait does not consume queued requests.
- Result contains no stable item ids, no participant ids (grep the JSON).
- `selectionToken` present iff the session has sticky steps; `resolveStep`
  returns the item id for a live alias and throws for an unknown alias, an
  unknown token, and an expired session.
- `replyVia` is `comment` for explain-type actions, `board` for ideate-type,
  and `conversation` whenever `canComment()` is false.

`apps/web/src/webmcp/collective-inquiry.test.ts` or a new
`collective-inquiry.tools.test.ts`: register against a fake
`document.modelContext` (same shape as the Playwright stub) and assert the
watch description lists `requested`; that `comment_on_watched_step` is
registered; that it calls `createComment` with the resolved item id and body;
that it rejects a 2,001-code-point body, a non-commenting role, and an alias
outside the watch; and that the token it mints is accepted by
`EducationPartnerWebMcp`'s `snapshot()` (construct one with `getSnapshot`
pointed at the inquiry instance and call `add_thinking_expansion` with
`sourceAliases: ["step_1"]`).

`apps/edge/src/board-room.test.ts` (next to the existing comment tests at
~7808): `assistedBy`/`assistance` round-trip through create → list; an
omitted pair reads back with neither field; `assistance` without
`assistedBy`, a bad tool name, and an unknown action are rejected with 400; a
legacy row inserted before the migration reads back as a typed comment;
`PATCH` resolve preserves the fields.

`apps/web/src/transport/api.test.ts` (or wherever `parseBoardComment` is
covered): absent fields parse; `assistedBy` without `assistance` throws
`INVALID_RESPONSE`.

`apps/web/src/ui/app.test.ts`: drawer renders the "AI · Critique" tag for an
assisted comment and no tag for a typed comment.

Renderer and alt-text tests are listed under steps 2c and 2d.

`apps/web/src/ui/app.test.ts`: if a `BoardApp` harness exists there for
selection actions, add: button hidden when idle; visible and enabled with a
watched selection; disabled with an unwatched id; menu closes on selection
change. Otherwise cover this in Playwright only.

### Step 6 — Playwright

`tests/playwright/webmcp-collective-inquiry.spec.ts` already stubs
`document.modelContext` and exposes tools on `window.__spaceScaleWebMcpTools`.
Add a test:

1. Create two stickies, select them, call
   `watch_board` with `{ action: "start" }` via `page.evaluate`.
2. Expect `[data-selection-ai]` visible; `[data-ai-watch-indicator]` visible.
3. Start a `wait` in the page (store the promise on `window`), click AI →
   Critique with a note, then await the promise and assert
   `status === "requested"`, `requests[0].steps[0].alias === "step_1"`,
   `responseGuidance.replyVia === "comment"`.
4. Call `comment_on_watched_step` with the returned `watchToken`, `step_1`,
   and a body containing `$x^2$`; assert the comments count badge increments,
   the comment appears in the drawer under the sticky with the author's name
   **and** the "AI · Critique" tag, and — in a second page on the same board
   (the two-client pattern in `collaboration.spec.ts`) — it arrives via the
   refresh broadcast with the same tag. Type a comment by hand in the
   composer and assert it has no tag.
5. Call `add_thinking_expansion` with the result's `selectionToken` and
   `sourceAliases: ["step_1"]`; assert two new cards appear and each carries
   `[data-assisted-by="ai"]` with a visible `.creator-badge-ai`; assert the
   participant's own stickies have none.
6. Deselect, select an unwatched sticky → button disabled with the title.
7. Call `stop` → button and indicator hidden.

Use the container's Chromium as in earlier sessions if the pinned Playwright
build is unavailable (`launchOptions.executablePath`).

### Step 7 — Docs

- `README.md` (line ~97): mention that while a watch is live the board shows
  an AI button that routes participant requests through the same watch.
- `docs/hackathon-build/spec.md` `watch_board` section: add
  the `requested` status, the action list, the 10-request cap, and the
  consume-on-deliver rule. Add a line to "Human-agent sequence" after the
  live-coaching paragraph.
- `docs/classroom-ai-safety.md` "Selected problem-step watch": state that
  board-initiated requests carry only watched-step aliases, text, the chosen
  action, and an optional 280-character note; that the button exists only
  while a watch is live; that `check_work` deliberately replaces grading; and
  that replies land as ordinary comments or cards attributed to the
  participant under the existing "Safety, review, and board mutations" rules.
  Rewrite the three "no AI-specific chrome or board labels" sentences (lines
  ~34-35, ~105, ~131-132): assisted items and comments carry `assistedBy`
  metadata **and** a small consistent AI mark so tool and human are always
  distinguishable; attribution still goes to the responsible participant, never
  a synthetic AI actor. Note that the caller's WebMCP permission is the
  confirmation for a comment, as it already is for the five headless card
  tools. Add `assistedBy`/`assistance` to the metadata-only audit record list.
- README (lines ~116-117) and `spec.md` (lines ~5, ~113-114): same rewrite —
  "retain internal `assistedBy` metadata and render a small AI mark beside the
  responsible participant's initials".
- README tool count: keep the published surface aligned with the final enabled
  tool set (currently fourteen).
- `spec.md` `add_content_visuals` section: alt text optional, title fallback.

### Step 8 — Optional follow-ups (not in v1)

- Presence broadcast of `aiWatching: boolean` so facilitators see who is being
  coached (protocol + edge + participant drawer; needs a safety-doc update).
- "Extend watch" to add a newly selected item mid-session.
- A per-action keyboard shortcut or a right-click entry on a step.
- Widening `CollectiveInquirySnapshot.sources[].kind` beyond `sticky` so
  canvas text, tables, and Section titles can be `add_*` sources too. The card
  builders only need bounds, so this is mostly a type change, but it touches
  `read_selected_class_ideas`'s contract and deserves its own review.
- Auto-opening the comments drawer on the step when an AI comment arrives in
  the requesting browser (match `requestId` to the next `server.comments.refresh`).
- Including comments (with `assistedBy`) in `export.attributed.json`, and
  the AI mark in SVG export alongside creator badges if those are ever added.
- Filtering the comments drawer, and a canvas toggle, by writer (person vs AI).
- Recording `assistance.tool`/`action` on generated *items* too (today items
  only carry the `"ai"` literal; the comment side records which tool and
  action). Needs a protocol field and a board-core round-trip test.

## Verification

```sh
npm run check                                   # biome + typecheck + vitest, as before every push
npx vitest run apps/web/src/webmcp              # feed and tool-surface tests
npx playwright test tests/playwright/webmcp-collective-inquiry.spec.ts
```

Manual: open a board in a WebMCP-capable host, select two steps, ask the host
to start the watch, confirm the AI button appears, send Critique, confirm the
host's next `wait` returns `requested` and the reply arrives as a comment on
the step (visible in a second browser too), send Ideate and confirm cards are
inserted, ask the host to stop, confirm the button disappears.

## Risks and open questions

- **Grade vs check_work** — decision needed (see Design decision 2). Default in
  this plan is `check_work`.
- **Self-declared assistance** — the edge cannot verify that `assistedBy`
  really came from an agent, or that content without it was made by hand; it
  trusts the page, exactly as it already does for items. The mark is an
  honest-client record, not a security boundary.
- **Migration ordering** — the web treats absent comment fields as a typed
  comment, so a web deploy ahead of the edge migration is safe; an edge deploy
  ahead of the web is safe because `parseBoardComment` ignores unknown keys.
  Both orders work.
- **Mark legibility at low zoom** — a 6 px glyph vanishes below ~50% zoom, as
  the initials badge already does. Acceptable: the `<title>` and drawer tag
  remain, and the mark is for at-a-glance reading, not the only signal.
- **Alt-text fallback quality** — a title like "Gravity meme" is a weaker
  description than a written alt, but it is never empty. Hosts can still
  supply `altText` when they have one.
- **Viewer-role participants** — a browser that can read but not comment gets
  `replyVia: "conversation"`; the button still works, the answer just stays in
  chat. The card tools already refuse without edit access.
- **Comment flooding** — a host that loops on `comment_on_watched_step` is
  bounded by the per-watch cap of 20 and the one-in-flight rule; the board's
  10,000-comment cap remains the hard stop.
- **Discoverability when idle** — the button is hidden with no watch. If that
  reads as "AI is missing", a disabled button with the title "Ask your AI
  assistant to watch your selected steps" is a one-line change in step 3.4;
  the safety doc's "no persistent AI-specific chrome" argues for hidden.
- **Host behaviour** — a host that ignores `requested` and only re-issues
  `wait` will simply see the request consumed with no reply. The tool
  description and `responseGuidance` are the only levers; the Codex host
  follows result guidance today for `changed`, so the risk is low.
- **Queue while the host is slow** — 10 requests cover any realistic burst; a
  participant clicking repeatedly sees a toast per click and the agent sees
  them batched in one result.
