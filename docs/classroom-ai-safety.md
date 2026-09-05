# Classroom AI safety and implementation gate

## Current status

SpaceScale now exposes a constrained WebMCP integration for the hackathon. The
application still embeds no AI provider, model binding, AI request route, or
provider credential: the visiting WebMCP host performs the reasoning. The
integration is discoverable in every browser that can open the board. Its reads
cover a bounded board watch the participant's host starts and stops, the
aggregate result of a selected vote table, and the board's own template
definitions. Writes submit validated ordinary board operations only when the
current participant has normal board edit permission.

The public hackathon deployment is an isolated demonstration for synthetic or
otherwise non-sensitive test content. It is not approval for use with real
students. This policy remains the gate for a classroom rollout: the school and
product owner must approve the specific feature, data flow, provider, and
audience first.

## Allowed purpose and control model

The first AI feature, if approved, must be a narrow facilitation aid such as
clustering selected sticky notes, suggesting group labels, summarizing a
selected section for the teacher, or drafting starter prompts. It must not grade,
profile, rank, discipline, diagnose, or make consequential decisions about a
student.

- Every browser with board access discovers the WebMCP tools. Read tools operate
  on the saved selection in that browser; write tools use the existing board
  edit permission and never elevate a viewer. A future classroom rollout must
  additionally add a server-enforced, fail-closed kill switch and board-level
  owner opt-in.
- The board header shows whether a WebMCP host is linked to this browser and how
  many tools it can see, so a participant can tell at a glance when an assistant
  is present. While a watch is live the tool rail also offers an AI action that
  shares the whole board. Both are deliberate, visible AI chrome.
- The WebMCP host surfaces tool calls and permissions. Generated items and
  comments retain internal `assistedBy` metadata, use the responsible
  participant's normal author badge, and carry a small, consistent AI mark so a
  reader can always tell tool-written content from a person's. SpaceScale adds
  no other AI chrome except the board's Ask AI button, which exists only while a
  problem-step watch is live in that browser.
- School approval and the applicable lawful basis, notice, and student or
  guardian consent must be recorded before use. Age and jurisdiction rules are
  determined by the school; uncertainty means the feature stays off.
- Withdrawing or losing the required approval immediately prevents new AI
  requests without affecting ordinary non-AI board tools.

## Data boundary

Scope is set deliberately, and differs by tool. The vote reader sees only the
aggregate counts of the selected vote table and the template reader sees no board
content at all. Everything else works in one of three scopes, which a tool either
reads once or follows live: the whole board, the objects selected in that browser,
or the saved work of named participants. The same scope means the same thing
either way, so a reading and a watch cannot disagree about what is in it. A watch
is the deliberate widening: it holds its scope open for as long as it runs, which
is what makes live coaching over handwriting workable. Starting one is an explicit
act by the participant's host, the board shows while one is running, and it expires
after 15 minutes. Beyond scope, a request carries only the minimum instruction
needed for the approved task.

Watched work may include the creator's board-visible display name and stable
opaque participant ID so the AI can associate an action with the correct person.
This permission does not extend to email addresses, contact details, board or item
IDs, access tokens, session data, presence data, activity history, or unsaved
keystrokes. Image pixels and file metadata are excluded: a private image card
appears in a watch picture as a placeholder, not as itself.

### Whole-board watch

`watch_board` lets a visiting WebMCP host follow this board for at most 15
minutes. It follows every saved object of any kind, including handwriting,
shapes, images and video embeds, and takes in objects saved after it started. It
reports only authoritative saved changes. This is the one tool whose scope is the
whole board rather than the browser selection: every other read tool still reads
only what the participant has selected.

Written work is reported as its saved text. Drawn work is reported as a short
description of what it is and the saved version it is at, and, because
handwriting cannot be coached from a description, every result about a board
holding drawn work also carries a PNG of that board. The picture is rendered in
the page from saved objects only; private image cards appear as placeholders
rather than their pixels, and its long edge is capped so a result stays a
readable size. A board of writing alone carries no picture.

The watch is a bounded sequence of cancelable long-poll tool calls rather than a
background SpaceScale model connection. Its page-memory token expires after 15
minutes, the participant can ask the host to stop it immediately, and navigating
away destroys it. Results use ephemeral `step_N` aliases and board-visible display
names only; they exclude stable participant, board, and item IDs, coordinates,
presence, history, contact details, and authentication data. Unsaved keystrokes
are never observed. Step content is marked as untrusted content, and the host is
instructed to comment briefly on the reasoning without grading, profiling, or
inferring ability.

While a watch is live the board shows an Ask AI button, and the tool rail offers
an AI action for the whole board. A participant's request
carries only step aliases and their content, the chosen action, and an optional
280-character note, and it reaches the host only through the watch's next long
poll. The action list deliberately offers "Check my work" (formative
verification, no score) instead of grading. The reply plan the watch returns names the
write to answer with: `insert_comment`, which posts an ordinary object comment
attributed to the requesting participant and tagged as AI-written, or
`insert_sticky` for a note beside the work. The caller's WebMCP permission is
the confirmation, as it is for every generic write.

### Following one person

The participant scope, reached through `list_users`, `read_user` and
`watch_users`, is the one place this integration is pointed at a person rather
than at a region of the board.

`list_users` exists to name someone: it reports each participant's board-visible
display name, the stable opaque participant ID the other two tools take, and how
many saved objects they have, by kind. It is built from saved board content, so
someone with no saved work does not appear. Object counts say how much work
exists. They are not a measure of effort or ability, and the tool says so where a
model will read it.

`read_user` and `watch_users` return that person's saved work in the same shape
the board scope returns anyone's. A watched person's object can also be changed by
somebody else — an owner tidying a board, a partner fixing a shared note — and the
change carries the board-visible name of whoever made it, because a reply that
misattributes an edit is worse than one that names the editor.

The constraint here is on use, not on what the tools return. Every one of them
instructs the model not to grade, rank, profile, or infer ability from what one
person's work shows, and the prohibition in this document against grading,
profiling, ranking, discipline and consequential decisions applies with particular
force to a scope built around an individual. A classroom rollout should treat
"follow this student" as a teacher-initiated, visible, time-bounded action; the
15-minute expiry and the board's own watch indicator exist so it cannot quietly
become continuous observation.

### Activity templates

`read_templates` works on the board's own template definitions, not on anyone's
work. It returns only what a template ships with: its label, description, object
kinds, and the text slots it holds, plus a rendered picture of templates that
draw. No board content, participant, or identifier is involved, so the read
carries nothing about a class at all.

`insert_filled_template` is the second half of that flow: it takes a templateId
and a list of slot-and-text pairs the read named, and lands the whole template as
one batch at the centre of the requesting participant's view. It can only fill
slots the template already defines, within the length each slot allows, so it
cannot invent structure or write outside one; a slot the call omits keeps the
placeholder the template ships with. The tool is instructed to fill the prompts,
questions, headings and category labels that frame the work, and to leave the
answer cells, votes, ratings and the class's own conclusions blank.

### Generic board writes

`insert_comment`, `insert_sticky`, `insert_image`, and `insert_video` each add
one thing to the board where the call asks, `insert_filled_template` adds one
template, and `move_stickies` rearranges notes that are already on the board. There is no separate authorization: every one refuses
without the participant's own edit access, refuses an object kind the Space owner
has switched off, and enters the same acknowledged realtime path as that
participant's own edit, so it inherits the board's locks, limits, validation,
history, and undo. Each returns what it wrote and where, and no board, item, or
participant identifier.

`insert_comment` attaches to a saved object rather than to empty canvas: either
the object covering the board coordinate the call names, or the one object
selected in that browser. It refuses when it can find neither, rather than
guessing a target. The comment is capped at 2,000 characters, is attributed to
the requesting participant with a visible AI tag, and can be resolved by the class
like any other comment.

A comment may also carry one picture or one video, never both. A picture takes
the same route `insert_image` does—inline bytes only, decoded, re-encoded, size
and dimension bounded, stored in the board's private bucket—so it needs the
participant's edit access and the Space's Images setting, and the comment names
the stored asset rather than any URL. A video is a public YouTube or Vimeo link
checked by the same parser the canvas embeds use, and it stays a link in the
drawer until a participant chooses to play it. The board refuses a picture it
does not already hold and a link it cannot recognize.

`insert_image` is an output-only image use case. It does not send existing board
images or file metadata to a model, and it never fetches an external URL: the
model supplies an inline PNG, JPEG, WebP, or GIF, which SpaceScale decodes and
re-encodes to strip metadata, holds to the existing type, byte, dimension, and
pixel limits, and stores only in the board's private asset bucket. It fails if
Images are disabled or the participant lacks edit access, and it requires alt text
so a card is never added that some participants cannot read. The tool is
instructed to depict no real student and not to ridicule or target an individual.

`insert_video` accepts only a complete HTTPS YouTube or Vimeo link, which the
board plays through its existing privacy-conscious embed.

`move_stickies` moves sticky notes so that notes carrying the same idea can be
gathered together. It names each note the way a comment does—by an alias a live
watch reported, or by a point the note covers—and never by an item id, and it
moves nothing else: a call that names a drawing, a text object, or a Section is
refused rather than partly applied, as is a call that names one note twice. The
board's own rules then decide what travels with each note, so a note leaving or
entering a Section changes membership and a grouped note brings its group, which
in turn carries that Section's own members. Whenever that reaches another note
the same call placed elsewhere, the call is refused rather than pulling the unit
apart, since no drag can produce that state; a note asked to stay put counts as
a placement, so it cannot be quietly carried along either. The
whole rearrangement is one batch within the Space's batch limit, so a class
reverses it with a single undo. Moving a note changes only its position: the note
keeps its author and is not marked as AI-written, because rearranging someone's
work is not authoring it. The tool is instructed never to arrange notes so as to
rank, grade, or single out a participant.

This control set is suitable for the synthetic hackathon demo; a real classroom
rollout still requires the provider, age-appropriateness, school approval, and
incident-response gates in this document.

The chosen provider and contract must require:

- no training, model improvement, advertising, profiling, or human review with
  classroom inputs or outputs;
- no provider retention or request logging beyond transient processing, unless
  a documented technical minimum is approved with a deletion deadline;
- encryption in transit, access controls, incident notification, documented
  subprocessors and processing region, and a school-approved data-processing
  agreement;
- deletion and export support sufficient for the school's student-data and
  records obligations.

Secrets remain server-side. Raw prompts, selected classroom content, model
responses, credentials, and provider request IDs must not appear in application
logs, analytics, error reports, or durable audit metadata.

## Safety, review, and board mutations

Inputs and outputs need age-appropriate content filtering and bounded size,
time, and rate limits. Unsafe, disallowed, or uncertain results fail closed and
leave the board unchanged. The WebMCP host surfaces tool calls and their
permissions; SpaceScale keeps `assistedBy` metadata on every AI-written item
and comment and shows a small AI mark beside the participant attribution.

Model output remains a proposal until the participant confirms its write. The
caller's WebMCP host permission shows the semantic tool invocation—including the
text, picture, or link proposed and where it would land—and serves as
confirmation when normal board edit permission also allows it. No tool may
create, update, delete, group, move, or otherwise mutate board items without this
confirmation. Confirmed actions pass
through the existing authorization, lock, limits, validation, history, undo,
snapshot, and export paths and are attributed to the confirming participant,
not to a synthetic AI participant.

The AI audit record should be metadata-only: approved feature name, policy and
provider version, confirming participant's opaque actor ID, affected item IDs,
time, outcome, and deletion status. Do not retain the raw input or output in
that record. Confirmed output is ordinary board content, so owners can undo or
delete it and it follows the normal board export and retention behavior. The
school must also be able to export or delete the associated AI audit metadata
and request deletion of any provider-held transient data.

## Implementation gate checklist

The hackathon demonstration may be exercised only with synthetic or otherwise
non-sensitive test content. No real-student classroom rollout may begin until
every applicable item below has an owner and recorded evidence.

### Governance and experience

- [ ] Define one narrow classroom use case, intended ages, prohibited uses,
  and the accountable school owner.
- [ ] Record school approval, lawful basis, notices, consent or assent rules,
  withdrawal flow, retention schedule, and data-subject request process.
- [ ] Design owner-only opt-in, participant disclosure, explicit selection,
  pre-send review, output labeling, teacher confirmation, and an immediate
  stop control.
- [ ] Preserve a complete non-AI path for the same classroom activity.

### Provider and data protection

- [ ] Document an exact data-flow inventory proving selected-content-only
  transfer and server-side identifier redaction.
- [ ] Approve the provider contract, no-training and retention terms,
  subprocessors, processing region, security controls, incident terms, and
  deletion/export procedure.
- [ ] Complete school privacy, safeguarding, security, accessibility, and
  procurement reviews appropriate to the deployment.

### Engineering and safety

- [ ] Add a server-enforced, fail-closed global kill switch plus board-level
  owner opt-in; do not expose provider credentials to the browser.
- [ ] Enforce role, board lock, consent state, selection bounds, request limits,
  filtering, timeouts, rate limits, and abuse controls at the Worker.
- [ ] Keep unconfirmed output out of board state, history, snapshots, exports,
  offline outboxes, analytics, and logs.
- [ ] Submit confirmed changes only as validated ordinary actions attributed to
  the teacher, with metadata-only AI auditing and tested delete/export paths.
- [ ] Test identifier removal, selection isolation, unsafe input/output,
  prompt-injection resistance, provider failure, revocation, concurrent role
  changes, lock changes, audit minimization, and kill-switch behavior.

### Rollout

- [ ] Obtain final written approval for the exact feature and configuration;
  generic approval for "AI" is insufficient.
- [ ] Pilot with synthetic or non-sensitive content in an isolated environment,
  then a small explicitly approved classroom cohort.
- [ ] Publish support, incident, deletion, and rollback procedures; monitor only
  privacy-safe operational metadata.
- [ ] Re-review before changing the provider, model, use case, input types,
  retention, audience, region, or subprocessors.

Until all required checks pass, the shipped sticky-note, template, section, voting,
and arrange tools remain the supported non-AI alternatives.
