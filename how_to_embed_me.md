# SpaceScale external partner integration guide

This is the single integration reference for embedding SpaceScale, launching
participants without another sign-in screen, controlling board capabilities,
initialising a new Space from JSON, exporting attributed data, using
Organisation templates, and receiving owner-triggered board webhooks.

The hosted endpoints used in the examples are:

| Environment | Base URL |
| --- | --- |
| Production | `https://your-spacescale.example` |
| Staging | `https://staging.example.test` |
| Local development | `http://localhost:8787` |

Use separate keys, Organisation registries, data, and allowed origins in every
environment.

## 1. Integration model

SpaceScale uses these neutral concepts:

- **Organisation** is the tenant and cryptographic boundary. Each Organisation
  has independent key material and its own reusable templates and webhook URL.
- **Space** is one persistent collaborative whiteboard. The pair
  `organisation_id` + `space_id` is its stable external identity.
- **Participant** is a person or service. A stable `participant_id` preserves
  that participant's attribution across every Space in the Organisation.
- **Board ID** is SpaceScale's opaque ID for a Space, for example
  `b_xxxxxxxxxxxxxxxxxxxxxx`. Export APIs use it and verify that it is the Space
  derived from the signed Organisation assertion.

Reusing the same `organisation_id` and `space_id` always opens the same current
board. It never creates a fresh copy or resets existing content. Multiple owners
are supported.

The trust boundary is deliberately simple:

1. SpaceScale stores an Organisation key registry as an encrypted Worker
   secret.
2. A partner's trusted backend stores only its Organisation's current key ID
   and signing key.
3. The backend signs one launch assertion per participant and puts the
   resulting URL in an iframe.
4. The HMAC key never enters the iframe, frontend JavaScript, query string, or
   URL fragment.

The signed assertion is authentication, not encryption. Its JSON payload can be
base64url-decoded by anyone who receives the URL. Use an opaque
`participant_id` rather than an email address if disclosing the identifier in a
short-lived launch URL is undesirable.

## 2. Provision one Organisation

Generate the derivation and launch-signing keys independently. Each decoded
value should contain at least 32 bytes of entropy:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Add the Organisation to the JSON value of the encrypted Worker secret
`ORGANISATION_SIGNING_KEYS`:

```json
{
  "acme-learning": {
    "derivation_key": "WORKER_ONLY_STABLE_SECRET_AT_LEAST_32_BYTES",
    "current": {
      "key_id": "2026-08",
      "key": "PARTNER_AND_WORKER_SIGNING_SECRET_AT_LEAST_32_BYTES"
    },
    "previous": []
  }
}
```

Install the complete registry in each hosted environment:

```sh
npx wrangler secret put ORGANISATION_SIGNING_KEYS
npx wrangler secret put ORGANISATION_SIGNING_KEYS --env staging
```

The registry supports at most 256 Organisations. An Organisation key is the
exact NFC-normalised, trimmed `organisation_id` used in launch claims. A signing
`key_id` is 1–64 characters matching `[A-Za-z0-9][A-Za-z0-9._-]*`. Every
derivation/signing secret must be unique across the registry. Up to eight
previous signing keys may be retained per Organisation.

Give the partner backend only these two current values:

```text
SPACESCALE_KEY_ID=2026-08
SPACESCALE_SIGNING_KEY=PARTNER_AND_WORKER_SIGNING_SECRET_AT_LEAST_32_BYTES
```

If this Organisation will receive owner-triggered webhooks, the SpaceScale
deployment operator must separately approve the receiver's exact origin in the
public Worker variable `WEBHOOK_ALLOWED_ORIGINS`:

```text
https://partner.example
https://partner.example,https://hooks.second-partner.example
```

This is a comma-separated deployment allowlist, not a secret and not the same
setting as iframe `ALLOWED_ORIGINS`. Missing or blank configuration denies every
webhook destination. Up to 64 exact HTTPS origins may be listed in at most 8
KiB. Entries cannot contain a path, query, fragment, credentials, or wildcard;
`*` is invalid and fails closed. A stored Organisation webhook URL may contain a
path beneath an approved origin.

Never give a partner the `derivation_key`. SpaceScale uses that stable,
Worker-only key to derive opaque Organisation, board, participant, custodian,
and recovery identities. Changing it would change those identities.

### Signing-key rotation

To rotate without interrupting active launch URLs:

1. Move the former `current` object into `previous`.
2. Generate a new independent key and unique `key_id`, and make it `current`.
3. Install the registry in the Worker.
4. Update the trusted partner backend to sign with the new current key.
5. Keep the previous key until all launch assertions it signed have expired,
   then remove it.

Do not change `derivation_key` during signing-key rotation. The current signing
key also signs outgoing webhook deliveries; webhook receivers select the key by
the `X-SpaceScale-Webhook-Key-Id` header.

## 3. Create signed participant launches

### Claim schema

An Organisation launch assertion has the compact form:

```text
el1.<base64url JSON payload>.<base64url HMAC-SHA256 signature>
```

The signature covers the literal bytes of `el1.<base64url JSON payload>`.

| Claim | Required | Contract |
| --- | --- | --- |
| `v` | yes | Integer `1`. |
| `aud` | yes | SpaceScale hostname only, such as `your-spacescale.example`; no scheme, path, or port. |
| `organisation_id` | yes | Stable Organisation key, 1–120 Unicode code points after NFC normalisation and trimming. |
| `space_id` | yes | Stable Space key and initial title, 1–120 Unicode code points after NFC normalisation and trimming. |
| `key_id` | yes | Key ID present in this Organisation's `current` or `previous` registry entry. |
| `role` | yes | `owner`, `editor`, or `viewer`. |
| `display_name` | yes | Name shown to other participants and in attributed exports, 1–40 visible Unicode code points after NFC normalisation and trimming. |
| `participant_id` | yes | Stable email or application identifier, at most 320 Unicode code points. It is present in the signed launch payload but is not returned in the resulting session/bootstrap or ordinary board-facing exports; the Organisation-authorised attributed export returns it to the trusted partner backend. |
| `iat` | yes | Issued-at Unix time in seconds. Up to five minutes of positive clock skew is accepted. |
| `exp` | yes | Expiry Unix time in seconds; later than `iat`, in the future, and no more than 24 hours after `iat`. |
| `features` | no | Partial object of the feature booleans in section 5. It seeds a new Space only. |
| `organisation_admin` | no | Boolean. `true`, together with `role: "owner"`, authorises Organisation administration and trusted-backend webhook settings. Never add it to an ordinary participant launch. |

Unknown claims and unknown feature keys are rejected. The complete assertion,
including a feature patch, is limited to 8 KiB.

### Node.js signing helper

Keep this code and its environment variables on the trusted backend:

```js
import { createHmac } from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createLaunchToken({
  hostname,
  organisationId,
  spaceId,
  keyId,
  signingKey,
  role,
  displayName,
  participantId,
  features,
  organisationAdmin,
  expiresInSeconds = 60 * 60,
}) {
  if (expiresInSeconds <= 0 || expiresInSeconds > 24 * 60 * 60) {
    throw new Error("expiresInSeconds must be between 1 and 86400");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    aud: hostname,
    organisation_id: organisationId,
    space_id: spaceId,
    key_id: keyId,
    role,
    display_name: displayName,
    participant_id: participantId,
    iat: now,
    exp: now + expiresInSeconds,
    ...(features === undefined ? {} : { features }),
    ...(organisationAdmin === undefined
      ? {}
      : { organisation_admin: organisationAdmin }),
  };

  const encodedPayload = base64url(JSON.stringify(payload));
  const signed = `el1.${encodedPayload}`;
  const signature = createHmac("sha256", signingKey)
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

export function createEmbedUrl({ origin, launchToken, initialTemplate }) {
  const fragment = new URLSearchParams({ launch: launchToken });
  if (initialTemplate !== undefined) {
    fragment.set("import", base64url(JSON.stringify(initialTemplate)));
  }
  return `${origin.replace(/\/$/u, "")}/embed#${fragment}`;
}
```

Example backend usage:

```js
const common = {
  hostname: "your-spacescale.example",
  organisationId: "acme-learning",
  spaceId: "geometry-2026-08-lesson-04",
  keyId: process.env.SPACESCALE_KEY_ID,
  signingKey: process.env.SPACESCALE_SIGNING_KEY,
};

const coachToken = createLaunchToken({
  ...common,
  role: "owner",
  displayName: "Meera Shah",
  participantId: "staff:4812",
  features: {
    images: false,
    protractor: true,
    line: true,
    lineSnapping: true,
  },
});

const studentToken = createLaunchToken({
  ...common,
  role: "editor",
  displayName: "Arun P.",
  participantId: "learner:90217",
  // Use the same first-launch features for every participant URL.
  features: {
    images: false,
    protractor: true,
    line: true,
    lineSnapping: true,
  },
});

const coachUrl = createEmbedUrl({
  origin: "https://your-spacescale.example",
  launchToken: coachToken,
});
const studentUrl = createEmbedUrl({
  origin: "https://your-spacescale.example",
  launchToken: studentToken,
});
```

Sign a separate URL for every participant. Do not share a single editor URL:
attribution is derived from `organisation_id` + `participant_id`, so shared
credentials intentionally look like one person.

### Complete JavaScript and Python examples

The repository includes equivalent dependency-free parent-backend examples:

- [JavaScript sample](examples/partner-integration.mjs) for Node.js 18 or newer;
- [Python sample](examples/partner_integration.py) for Python 3.10 or newer.

Both examples:

1. create owner and editor assertions using `key_id`;
2. produce participant-specific iframe URLs;
3. create a separate short-lived Organisation administrator assertion;
4. attach a canonical initial template to the owner URL;
5. optionally pre-create the Space and apply that template atomically;
6. call canonical and attributed export APIs;
7. list, create, and edit Organisation templates.

Run either with the same parent-server configuration:

```sh
export SPACESCALE_ORIGIN=https://your-spacescale.example
export SPACESCALE_ORGANISATION_ID=acme-learning
export SPACESCALE_KEY_ID=2026-08
export SPACESCALE_SIGNING_KEY='replace-with-the-current-organisation-signing-key'
export SPACESCALE_SPACE_ID=geometry-2026-08-lesson-04

node examples/partner-integration.mjs
# or
python3 examples/partner_integration.py
```

The programs print signed iframe URLs, so run them only in a trusted backend
environment and do not put their output in application logs. Omit
`SPACESCALE_SPACE_ID` to generate a fresh sample Space name. Reusing the same
stable Space ID resumes that Space; its initial template is not reapplied.

## 4. Embed the Space

```html
<iframe
  src="SIGNED_SPACE_URL"
  title="Shared SpaceScale board"
  allow="clipboard-read; clipboard-write"
  style="display:block;width:100%;height:720px;border:0"
></iframe>
```

If the parent page applies its own Content Security Policy, allow the selected
SpaceScale origin in `frame-src`. Avoid an iframe `sandbox` attribute unless it
is required by the host application. If used, it must at least allow scripts,
same-origin behavior, forms, and downloads for the full board experience:

```html
<iframe
  src="SIGNED_SPACE_URL"
  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
  allow="clipboard-read; clipboard-write"
  title="Shared SpaceScale board"
></iframe>
```

SpaceScale must also allow the parent origin. Set `ALLOWED_ORIGINS` on the
Worker to one of:

```text
https://app.partner.example
https://app.partner.example,https://lms.partner.example
*
```

Missing, blank, malformed, or partly invalid configuration denies all framing.
Origins must be exact HTTPS origins with no path, query, fragment, credentials,
or wildcard; local development additionally accepts exact `http://localhost`,
`http://127.0.0.1`, and `http://[::1]` origins. At most 20 origins may be listed.
A literal `*` deliberately permits every parent and should be used only when
that is the intended policy.

The launch assertion and optional import are placed in the URL fragment, not
the query string. A fragment is not sent as an HTTP request target or referrer.
Before its first network exchange, the SpaceScale client removes the fragment
from browser-visible history. It exchanges the launch assertion for a
Space-scoped `es1` session, stores that session only in the iframe's history
state, and changes the iframe path to `/embed/b/<board-id>`.

If the iframe is reloaded after its history state has been discarded, launch it
again from a newly signed parent URL. No SpaceScale login or board picker is
shown.

Organisation-signed embed launches do not require Turnstile. Turnstile protects
only public capability-issuing flows, not the trusted Organisation launch
exchange or the server-to-server Organisation APIs.

### Invisible, risk-based Turnstile behavior

In production, enabling Turnstile does not add an intermediate verification
page and does not require every user to complete a challenge. Normal browser
requests continue immediately without loading a widget. A request is challenged
only when available Cloudflare Bot Management signals identify likely
automation (score `1..29` or failed JavaScript detection), or narrow fallback
signals indicate an empty/automation user agent or an unexpected cross-site
request. Cloudflare-verified bots and static-resource signals are exempt.

For a suspected request, the API returns `428 TURNSTILE_REQUIRED`. The official
client mounts the Turnstile widget explicitly with interaction-only appearance,
obtains an action-bound token, and retries the original operation once. Configure
the production Turnstile widget in **Invisible** mode. Cloudflare may still show
an interaction when its challenge policy requires one. SpaceScale validates the
hostname and exact action server-side. The protected actions are
`board_create`, `invitation_claim`, and `recovery_claim`.

Staging and local development keep Turnstile disabled so browser automation can
run without Cloudflare credentials or interaction.

## 5. Feature flags

`features` is a partial object in a signed launch. Omitted keys receive the
defaults below. The first successful launch that creates a Space persists the
complete resulting feature set. Later launches never overwrite it. An online
owner may change the persisted values from **Settings → Features**, and changes
are broadcast to participants in real time.

| Key | Default | Controls |
| --- | ---: | --- |
| `pencil` | `true` | Freehand pencil strokes. |
| `line` | `true` | Straight lines and optional end arrows. |
| `lineSnapping` | `true` | Snapping new line endpoints to nearby geometry and protractor marks. It has no effect if `line` is disabled. |
| `square` | `true` | Square preset. |
| `rectangle` | `true` | Rectangle preset. |
| `triangle` | `true` | Triangle preset. |
| `rhombus` | `true` | Rhombus preset. |
| `pentagon` | `true` | Pentagon preset. |
| `hexagon` | `true` | Hexagon preset. |
| `circle` | `true` | Circle/ellipse item creation through the circle preset. |
| `text` | `true` | Free canvas text and its font controls. |
| `stickyNotes` | `true` | Resizable sticky-note cards. |
| `stamps` | `true` | Star, check, heart, question, smile, and sparkle stickers. |
| `images` | `false` | Private board image uploads and image cards. |
| `tables` | `true` | Resizable tables, rows, and columns. |
| `sections` | `true` | Resizable named Sections (`zone` items in JSON). |
| `grouping` | `true` | Explicit multi-item groups and automatic Section membership for grouped move/copy behavior. |
| `protractor` | `true` | Movable 180° digital protractor; rotation also requires `objectTransforms`. |
| `eraser` | `true` | Eraser tool. |
| `partialEraser` | `true` | Cutting only touched portions of pencil, line, rectangle, ellipse, and polygon outlines. Requires `eraser`; the Settings UI disables this control while `eraser` is off. |
| `objectTransforms` | `true` | Proportional corner scaling for shapes and images, plus center-pivot rotation for shapes, images, and the protractor. Hold Shift while rotating to snap to 15° steps. Moving remains available when disabled. |
| `templates` | `true` | Built-in starter templates. A template is unavailable if it contains an item whose feature is disabled. |
| `organisationTemplates` | `true` | Organisation-owned reusable templates. Independent of built-in `templates`. |
| `voting` | `true` | Voting template and vote overlays/actions. |
| `spotlight` | `true` | Coach-led **Follow me** viewport spotlight. |

Example restricted activity:

```json
{
  "features": {
    "pencil": false,
    "images": false,
    "stamps": false,
    "templates": false,
    "organisationTemplates": false,
    "voting": false,
    "protractor": true,
    "line": true,
    "lineSnapping": true,
    "square": true,
    "rectangle": true,
    "triangle": true,
    "rhombus": true,
    "pentagon": true,
    "hexagon": true,
    "circle": true
  }
}
```

Feature flags hide official controls and are authoritatively enforced for item
creation, shape subtype changes, partial-erased geometry, protractors,
Organisation template endpoints, and spotlight. Some interaction semantics,
such as whether an ordinary valid line coordinate came from snapping, are
necessarily client behavior rather than a distinct stored operation.

## 6. Roles, ownership, locking, and persistence

| Role | Behavior |
| --- | --- |
| `owner` | Can manage settings, features, locks, members, co-owners, exports, Organisation templates, and webhook delivery. Can modify any participant's object. |
| `editor` | Can create work and modify or delete only objects that participant created. May also detach any participant's object from a Section the editor created (a bare `sectionId: null` update), which is what lets the editor delete or undo that Section. |
| `viewer` | Can view and follow live work but cannot commit canvas changes. |

There may be multiple owners. The board also retains one primary owner for
recovery/custody operations; ordinary co-owner collaboration is not limited to
that primary owner.

Owners can change the drawing policy live:

- `editors_enabled`: owners and editors may draw, subject to ownership rules.
- `owner_only`: owners may draw; everyone else watches.
- `locked`: nobody, including owners, may commit drawing changes until an owner
  unlocks the Space.

On every valid relaunch, SpaceScale can refresh that participant's display name
and role. Newer `iat` values win over older launches, preventing an old URL from
undoing a newer role assignment. Explicit primary ownership transfer remains a
separate owner operation.

Board content, settings, roles, and attribution are durable. Presenting a board
name that already exists resumes exactly its current state. Launch-time feature
flags and initial imports are never reapplied to an existing Space.

### Invite a co-owner

Owners can use **Share → Invite → Co-owner**. The underlying Space-scoped API is:

```http
POST /api/v1/boards/<board-id>/invitations
Idempotency-Key: 018f0000-0000-7000-8000-000000000900
Content-Type: application/json

{
  "role": "owner",
  "label": "Workshop facilitator",
  "maxUses": 1,
  "expiresAtMs": 1788748200000
}
```

The response contains `invitation.id`, `token`, and
`/b/<board-id>#invite=<token>`. Claiming it creates an ordinary non-primary
co-owner; primary recovery custody is unchanged. The same API accepts
`viewer` and `editor`. An Organisation partner normally does not need this
API: issue that person a standard signed launch with `role: "owner"` instead.


## 7. Initial template/import format

An owner URL may include an initial canonical export as
`#launch=...&import=<base64url JSON>`. It is applied atomically only if that owner
launch creates a brand-new Space. It is ignored when the Space already exists,
so URL retries cannot overwrite work. Editor and viewer launches cannot
initialise a Space.

Limits:

- decoded UTF-8 JSON: 1 MiB maximum;
- live items: 1,000 maximum for URL import;
- exact canonical schema shown below;
- image items are not importable because canonical JSON does not contain their
  private image bytes;
- item IDs and `z` values must be unique;
- imported paint order and IDs are retained, while `z` is canonicalised to
  `1..n`, every imported item begins at version `1`, and the import becomes one
  synthetic initial-state revision;
- imported `settings.title` becomes the new Space title. Without an import,
  `space_id` is the initial title.

Initial Section locks are part of the template itself, not the signed launch
assertion. Set `geometry.locked` to `true` on any `zone` item that should begin
locked, and give every contained item that Section's ID as its `sectionId`.
The first owner launch persists and enforces those locks before any participant
opens the Space. The checked-in JavaScript and Python partner samples expose
this as `lockSections: true` and `lock_sections=True`, respectively. It remains
initial-state-only: a later launch cannot relock or unlock an existing Space.

A small valid initial template is:

```json
{
  "format": "cf-whiteboard-json",
  "version": 1,
  "boardId": "b_AAAAAAAAAAAAAAAAAAAAAA",
  "seq": 0,
  "createdAt": 1786156200000,
  "settings": {
    "title": "Geometry reflection"
  },
  "items": [
    {
      "id": "018f0000-0000-7000-8000-000000000001",
      "kind": "text",
      "z": 1,
      "version": 0,
      "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "style": {
        "kind": "text",
        "color": "#1f2937",
        "fontSize": 32,
        "fontFamily": "sans",
        "opacity": 1
      },
      "transform": [1, 0, 0, 1, 0, 0],
      "geometry": {
        "x": 80,
        "y": 70,
        "text": "Construct and explain a 65° angle"
      }
    },
    {
      "id": "018f0000-0000-7000-8000-000000000002",
      "kind": "protractor",
      "z": 2,
      "version": 0,
      "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "style": {
        "kind": "protractor",
        "color": "#7c3aed",
        "opacity": 0.8
      },
      "transform": [1, 0, 0, 1, 350, 350],
      "geometry": {
        "radius": 180
      }
    }
  ]
}
```

The source `boardId` only has to be a canonical board ID; the import is rebound
to the destination Space's derived board ID. For URL import, every `createdBy`
must be an opaque Participant ID matching `a_` followed by 22 base64url
characters. Initial content attribution falls back to the supplied creator ID.
Use a stable synthetic `a_...` source-author ID if the template was not made by
a SpaceScale participant.

To attach it:

```js
const ownerUrl = createEmbedUrl({
  origin: "https://your-spacescale.example",
  launchToken: coachToken,
  initialTemplate,
});
```

## 8. Board data APIs

There are two ways to export:

1. In-board exports use a Space-scoped embed session and are intended for the
   SpaceScale UI. Owners can download attributed JSON from Settings; any member
   who can view may download canonical JSON or SVG.
2. Organisation server APIs let a trusted partner backend fetch JSON or
   permanently delete a board by Organisation and board ID without handling the
   iframe's session.

### Server-to-server authentication

Create a fresh `el1` launch assertion with:

- the same `organisation_id` and `space_id` as the target board;
- `role: "owner"`;
- a stable backend/service `participant_id` and useful `display_name`;
- a short practical expiry;
- the Organisation's current `key_id` and signing key.

Send the assertion directly as a bearer token. Do not put an embed session,
Cloudflare API token, raw signing key, or derivation key in this header.
The same authentication contract applies to export and board deletion.

```http
Authorization: Bearer el1.<payload>.<signature>
Accept: application/json
```

The Worker verifies the HMAC, expiry, audience, owner role, Organisation route,
and that the route's board ID is exactly the board derived from the signed
`organisation_id` + `space_id`. A token for another Organisation or Space is
rejected. Missing, Organisation-mismatched, and board-mismatched targets all
return `404 NOT_FOUND` to avoid exposing cross-tenant existence. Archived
Spaces remain exportable through this trusted Organisation API.
For these server-to-server routes, the signed owner role is trusted
Organisation-backend authority; it is not rechecked against the Space's live
participant list. Use a dedicated service `participant_id` and a short expiry.
Demoting a human in the iframe does not revoke an already-issued backend
assertion. To revoke backend authority immediately, remove/rotate that
Organisation signing key and stop issuing assertions with its key ID.

The opaque board ID appears in SpaceScale board URLs and in every export and
webhook payload. Persist it alongside your stable `space_id` once obtained.

If the backend must resolve and persist the board ID before rendering the first
iframe, it may perform the same launch exchange used by the iframe:

```http
POST /api/v1/embed/session
Host: your-spacescale.example
Origin: https://your-spacescale.example
Content-Type: application/json

{"token":"<owner-el1-assertion>"}
```

The JSON response includes `board.id`. Discard the returned `sessionToken`; it
is for an iframe, not server-to-server export authentication. The exchange also
creates the Space if it does not yet exist. If this first exchange should apply
an initial template, include its already-base64url-encoded value as
`importSnapshot` in the request body; otherwise the Space will already exist
when the iframe later opens and its fragment import will correctly be ignored.
This lookup is optional—the normal iframe launch needs no preliminary call.

### Canonical state export

```http
GET /api/v1/organisations/acme-learning/boards/b_xxxxxxxxxxxxxxxxxxxxxx/export.json
Host: your-spacescale.example
Authorization: Bearer <fresh-owner-el1-assertion>
```

Response body:

```json
{
  "format": "cf-whiteboard-json",
  "version": 1,
  "boardId": "b_xxxxxxxxxxxxxxxxxxxxxx",
  "seq": 84,
  "createdAt": 1786156200000,
  "settings": {
    "title": "Geometry reflection"
  },
  "items": [
    {
      "id": "018f0000-0000-7000-8000-000000000113",
      "kind": "zone",
      "z": 1,
      "version": 1,
      "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "style": {
        "kind": "zone",
        "borderColor": "#60a5fa",
        "fill": "#eff6ff",
        "textColor": "#1e3a8a",
        "fontSize": 20,
        "opacity": 0.8
      },
      "transform": [1, 0, 0, 1, 0, 0],
      "geometry": {
        "x": 40,
        "y": 40,
        "width": 760,
        "height": 420,
        "title": "Group A"
      }
    },
    {
      "id": "018f0000-0000-7000-8000-000000000109",
      "kind": "sticky",
      "z": 2,
      "version": 1,
      "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "sectionId": "018f0000-0000-7000-8000-000000000113",
      "style": {
        "kind": "sticky",
        "fill": "#fde68a",
        "textColor": "#1f2937",
        "fontSize": 18,
        "opacity": 1
      },
      "transform": [1, 0, 0, 1, 0, 0],
      "geometry": {
        "x": 80,
        "y": 120,
        "width": 220,
        "height": 160,
        "text": "Explain your construction"
      }
    }
  ],
  "sections": [
    {
      "id": "018f0000-0000-7000-8000-000000000113",
      "name": "Group A",
      "locked": false,
      "memberItemIds": ["018f0000-0000-7000-8000-000000000109"]
    }
  ]
}
```

Each contained item carries its Section ID in `sectionId`, while the derived
top-level `sections` index makes the same relationship easy to consume without
scanning all items. Imports may include the `sections` index, but `sectionId`
on each item is authoritative and the index is recalculated on export.

The response is an authoritative snapshot suitable for storage or a later
first-launch import, subject to the smaller URL-import limits and the image
restriction. Headers include `Content-Type: application/json`, `Cache-Control:
no-store`, `ETag`, and `X-Whiteboard-Seq`.

Example:

```js
const token = createLaunchToken({
  hostname: "your-spacescale.example",
  organisationId: "acme-learning",
  spaceId: "geometry-2026-08-lesson-04",
  keyId: process.env.SPACESCALE_KEY_ID,
  signingKey: process.env.SPACESCALE_SIGNING_KEY,
  role: "owner",
  displayName: "Acme export service",
  participantId: "service:board-export",
  expiresInSeconds: 5 * 60,
});

const response = await fetch(
  "https://your-spacescale.example/api/v1/organisations/acme-learning/boards/b_xxxxxxxxxxxxxxxxxxxxxx/export.json",
  { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
);
if (!response.ok) throw new Error(await response.text());
const canonicalExport = await response.json();
```

### Attributed data export

```http
GET /api/v1/organisations/acme-learning/boards/b_xxxxxxxxxxxxxxxxxxxxxx/export.attributed.json
Host: your-spacescale.example
Authorization: Bearer <fresh-owner-el1-assertion>
```

The response is a current-state snapshot, not a complete revision-history
ledger:

```json
{
  "format": "cf-whiteboard-attributed-json",
  "version": 1,
  "board": {
    "id": "b_xxxxxxxxxxxxxxxxxxxxxx",
    "title": "Peer feedback",
    "seq": 84,
    "stateCreatedAt": 1786156200000
  },
  "participants": [
    {
      "id": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "displayName": "Arun P.",
      "participantHash": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "participantId": "learner:90217",
      "role": "editor",
      "status": "active"
    }
  ],
  "sections": [
    {
      "id": "018f0000-0000-7000-8000-000000000113",
      "name": "Peer review",
      "locked": true,
      "memberItemIds": ["018f0000-0000-7000-8000-000000000010"]
    }
  ],
  "objects": [
    {
      "item": {
        "id": "018f0000-0000-7000-8000-000000000010",
        "kind": "sticky",
        "z": 1,
        "version": 3,
        "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
        "sectionId": "018f0000-0000-7000-8000-000000000113",
        "style": {
          "kind": "sticky",
          "fill": "#fde68a",
          "textColor": "#1f2937",
          "fontSize": 18,
          "opacity": 1
        },
        "transform": [1, 0, 0, 1, 0, 0],
        "geometry": {
          "x": 100,
          "y": 140,
          "width": 220,
          "height": 160,
          "text": "Could you explain why alternate angles are equal?"
        }
      },
      "attribution": {
        "createdBy": {
          "id": "a_AAAAAAAAAAAAAAAAAAAAAA",
          "displayName": "Arun P.",
          "participantHash": "a_AAAAAAAAAAAAAAAAAAAAAA",
          "participantId": "learner:90217"
        },
        "lastModifiedBy": {
          "id": "a_AAAAAAAAAAAAAAAAAAAAAA",
          "displayName": "Arun P.",
          "participantHash": "a_AAAAAAAAAAAAAAAAAAAAAA",
          "participantId": "learner:90217"
        },
        "updatedSeq": 84,
        "updatedAt": 1786156200000
      },
      "content": [
        {
          "kind": "sticky_text",
          "text": "Could you explain why alternate angles are equal?",
          "responsibleUser": {
            "id": "a_AAAAAAAAAAAAAAAAAAAAAA",
            "displayName": "Arun P.",
            "participantHash": "a_AAAAAAAAAAAAAAAAAAAAAA",
            "participantId": "learner:90217"
          },
          "lastChangedBy": {
            "id": "a_AAAAAAAAAAAAAAAAAAAAAA",
            "displayName": "Arun P.",
            "participantHash": "a_AAAAAAAAAAAAAAAAAAAAAA",
            "participantId": "learner:90217"
          },
          "updatedSeq": 84,
          "updatedAt": 1786156200000
        }
      ]
    }
  ]
}
```

Every participant and nested actor reference includes `participantHash`. It is
the Organisation-scoped HMAC pseudonym derived from the stable
`participant_id`; it is stable across Spaces in one Organisation and different
across Organisations. In the current wire format it is the same opaque
`a_...` value as the actor `id`. It supports cross-Space uniqueness without
revealing an email or partner identifier.


Participant `status` is `active`, `revoked`, or `referenced`; `role` is null for
a creator referenced by content but no longer present in the membership table.
On this Organisation-authenticated endpoint, `participantId` is the original
stable launch `participant_id` for a known member and is null for a synthetic or
otherwise unresolved referenced creator. This is the field a partner should use
to join board attribution back to its own user records. It appears in the
participant directory and in every `createdBy`, `lastModifiedBy`,
`responsibleUser`, and `lastChangedBy` actor reference. The owner download at
`/api/v1/boards/<board-id>/export.attributed.json` deliberately omits
`participantId` because it is a board-facing export rather than an
Organisation-backend integration; it still includes `participantHash` on every
actor reference. Content entries use these kinds:

| Item content | `content[].kind` | Extra fields |
| --- | --- | --- |
| Canvas text | `text` | none |
| Sticky note body | `sticky_text` | none |
| Section title | `zone_title` | none |
| Image alternative text | `image_alt` | none |
| Table cell | `table_cell` | zero-based `row` and `column` |

`responsibleUser` records who is responsible for the current content;
`lastChangedBy` records the last participant to change that content. Either can
be null for older/restored data without content-level attribution. This format
supports questions such as which participant asked a question, who gave a piece
of feedback, and which participant left a table cell incomplete.

### Delete a board

```http
DELETE /api/v1/organisations/acme-learning/boards/b_xxxxxxxxxxxxxxxxxxxxxx
Host: your-spacescale.example
Authorization: Bearer <fresh-owner-el1-assertion>
```

Or from a command line:

```sh
curl -i -X DELETE \
  -H "Authorization: Bearer $SPACESCALE_OWNER_TOKEN" \
  "https://your-spacescale.example/api/v1/organisations/acme-learning/boards/b_xxxxxxxxxxxxxxxxxxxxxx"
```

A successful deletion returns `204 No Content`. The operation is idempotent, so
retry the identical request after a network failure or `503`. Only an owner
assertion for the exact Organisation and Space-derived board ID is accepted;
editor, viewer, cross-Organisation, and cross-Space assertions cannot delete it.

Deletion permanently removes the authoritative board database, action history,
memberships, settings, recovery snapshots, private image assets, and the board's
row in Organisation administration. Connected participants are disconnected.
Existing board, viewer, and asset sessions stop working. Export anything that
must be retained before calling this endpoint.

Because board IDs are deterministically derived from `organisation_id` and
`space_id`, a later fresh owner launch using the same pair creates a new blank
Space with the same board ID. It does not restore any deleted content. A launch
that supplies an initial template may initialise that newly recreated Space.

JavaScript:

```js
export async function deleteBoard({ origin, organisationId, boardId, ownerToken }) {
  const response = await fetch(
    `${origin}/api/v1/organisations/${encodeURIComponent(organisationId)}` +
      `/boards/${encodeURIComponent(boardId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  if (!response.ok) throw new Error(await response.text());
}
```

Python:

```python
def delete_board(origin, organisation_id, board_id, owner_token):
    path = (
        f"/api/v1/organisations/{quote(organisation_id, safe='')}"
        f"/boards/{quote(board_id, safe='')}"
    )
    request = Request(
        f"{origin.rstrip('/')}{path}",
        method="DELETE",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    with urlopen(request, timeout=30) as response:
        if response.status != 204:
            raise RuntimeError(f"Unexpected status: {response.status}")
```

The runnable JavaScript and Python examples in `examples/` also expose this
helper without invoking it automatically.

## 9. Read-only JSON viewer and Organisation administration

### View a JSON export locally

Open:

```text
https://your-spacescale.example/viewer
```

Paste a canonical `cf-whiteboard-json` export or choose a local `.json` file.
The file stays in the browser. The viewer renders the production board model,
supports drag-to-pan, wheel/buttons/keyboard zoom, **Fit**, and native text
selection/copy. It has no mutation controls, session bootstrap, WebSocket,
autosave, member controls, or write API. Only canonical exports are accepted;
attributed exports must first supply their canonical board/items representation.

### Create a signed view-only URL

Create a normal `el1` assertion for the target Organisation and Space with
`role: "viewer"`, then put it in this fragment:

```js
const viewerToken = createLaunchToken({
  ...common,
  role: "viewer",
  displayName: "Read-only review",
  participantId: "service:read-only-review",
  expiresInSeconds: 60 * 60,
});

const viewerUrl =
  `https://your-spacescale.example/viewer#launch=${encodeURIComponent(viewerToken)}`;
```

On load, SpaceScale removes the token from browser-visible history before the
network request, exchanges it at `POST /api/v1/viewer/session`, fetches the
authoritative canonical snapshot for the derived Space, and renders it locally.
The successful exchange also returns a short-lived, viewer-only image capability
that remains in page memory. The viewer uses it in an `Authorization` header on
`GET /api/v1/viewer/assets/{assetId}` to stream the matching private R2 object.
The capability is never placed in a URL or persistent browser storage and cannot
authenticate board mutation, membership, WebSocket, or editing APIs. This header
flow remains reliable when the viewer is embedded and third-party cookies are
blocked. The launch token is an HMAC assertion; neither the Organisation signing
key nor a raw backend secret is present in the URL.

Canonical exports reference private image asset IDs but do not contain image
bytes. The **signed** viewer resolves those IDs through the authenticated loader
and displays the original images. The manual JSON-only viewer has no Space
authorisation context, so it preserves image position and size but displays the
standard placeholder.

### Open Organisation administration

Create a separate, short-lived owner assertion with `organisation_admin: true`.
Do not reuse a coach or participant's ordinary Space launch:

```js
const adminToken = createLaunchToken({
  ...common,
  role: "owner",
  displayName: "Organisation administrator",
  participantId: "service:organisation-admin",
  organisationAdmin: true,
  expiresInSeconds: 15 * 60,
});

const adminUrl =
  `https://your-spacescale.example/organisation/admin#launch=${encodeURIComponent(adminToken)}`;
```

The admin application removes the fragment before loading. It shows every
Space registered for that Organisation, Space owners, participants, stable
hashed participant hints, and a pre-signed **Open viewer** link. It also shows
all Organisation-level settings currently supported: webhook URL,
Organisation ID, Space count, template count, and viewer-link validity. The
webhook URL can be changed or cleared there.

A Space enters the Organisation registry on its first successful signed launch.
Subsequent launches and owner membership/settings changes update the same row;
reusing `organisation_id` + `space_id` never creates another Space.

The browser endpoints are:

```text
POST /api/v1/organisation-admin/session
POST /api/v1/organisation-admin/webhook
```

Both accept the signed owner assertion as `token` in same-origin JSON and
require `organisation_admin: true`; otherwise they return `403 FORBIDDEN`. The
second also accepts `webhookUrl` as a public HTTPS URL or `null`. They are
browser implementation endpoints, not a substitute for the bearer-authenticated
server export and webhook APIs in sections 8 and 11. Admin-generated viewer
links use a server-issued 12-hour viewer assertion.


## 10. Organisation templates

Organisation templates are reusable board layouts stored once per Organisation.
They are separate from initial URL imports and built-in templates.

Board-facing routes, authenticated by the current Space session, are:

```text
GET    /api/v1/boards/<board-id>/organisation/templates
POST   /api/v1/boards/<board-id>/organisation/templates
PATCH  /api/v1/boards/<board-id>/organisation/templates/<template-id>
DELETE /api/v1/boards/<board-id>/organisation/templates/<template-id>
```

A trusted parent backend can manage the same Organisation-wide collection
without an iframe session:

```text
GET    /api/v1/organisations/<organisation-key>/templates
POST   /api/v1/organisations/<organisation-key>/templates
PATCH  /api/v1/organisations/<organisation-key>/templates/<template-id>
DELETE /api/v1/organisations/<organisation-key>/templates/<template-id>
```

Send a fresh owner `el1` assertion in
`Authorization: Bearer <assertion>`. The assertion's `organisation_id` must
exactly match the URL-decoded Organisation path. Editor and viewer assertions
receive `403 FORBIDDEN`; a cross-Organisation path receives `404 NOT_FOUND`.
The server `GET` response contains `organisationId` and `templates`; the
board-facing response additionally contains `canManage`.

`GET` returns:

```json
{
  "organisationId": "o_AAAAAAAAAAAAAAAAAAAAAA",
  "canManage": true,
  "templates": [
    {
      "id": "tpl_AAAAAAAAAAAAAAAAAAAAAA",
      "name": "Two-column reflection",
      "description": "Prompt and response areas",
      "items": [
        {
          "id": "018f0000-0000-7000-8000-000000000020",
          "kind": "zone",
          "z": 1,
          "version": 1,
          "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
          "style": {
            "kind": "zone",
            "borderColor": "#60a5fa",
            "fill": "#dbeafe",
            "textColor": "#1e3a8a",
            "fontSize": 20,
            "opacity": 0.8
          },
          "transform": [1, 0, 0, 1, 0, 0],
          "geometry": {
            "x": 80,
            "y": 120,
            "width": 420,
            "height": 320,
            "title": "My reasoning"
          }
        }
      ],
      "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "createdAt": 1786156200000,
      "updatedAt": 1786156200000
    }
  ]
}
```

An owner creates a template with the public board request body:

```json
{
  "name": "Two-column reflection",
  "description": "Prompt and response areas",
  "items": [
    {
      "id": "018f0000-0000-7000-8000-000000000020",
      "kind": "zone",
      "z": 1,
      "version": 1,
      "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
      "style": {
        "kind": "zone",
        "borderColor": "#60a5fa",
        "fill": "#dbeafe",
        "textColor": "#1e3a8a",
        "fontSize": 20,
        "opacity": 0.8
      },
      "transform": [1, 0, 0, 1, 0, 0],
      "geometry": {
        "x": 80,
        "y": 120,
        "width": 420,
        "height": 320,
        "title": "My reasoning"
      }
    }
  ]
}
```

Creation returns the stored template with status `201`. Editing uses a
partial `PATCH`: include at least one of `name`, `description`, or `items`.
Setting `description` to `null` clears it. Supplying `items` replaces the
complete object list after normal validation; omitted fields remain unchanged.

```http
PATCH /api/v1/organisations/acme-learning/templates/tpl_AAAAAAAAAAAAAAAAAAAAAA
Authorization: Bearer <fresh-owner-el1-assertion>
Content-Type: application/json

{
  "name": "Revised two-column reflection",
  "description": null
}
```

A successful edit returns the complete updated template with status `200`;
delete returns `204`. The
[JavaScript sample](examples/partner-integration.mjs) calls
`createOrganisationTemplate`, `updateOrganisationTemplate`, and
`listOrganisationTemplates`. The
[Python sample](examples/partner_integration.py) provides the equivalent
`create_organisation_template`, `update_organisation_template`, and
`list_organisation_templates` functions.

The UI automatically supplies `Idempotency-Key` for creation and sends the
creator identity internally. Owners may create, edit, and delete templates; editors and
viewers may insert them only when their role, board lock, and item feature flags
permit drawing.

Limits are 100 templates per Organisation, 1–100 items per template, 512 KiB
per template, and 5 MiB total Organisation template storage. Item IDs and `z`
values must be unique. Image items are not supported in Organisation templates.
Insertion creates new object IDs and attributes the inserted objects to the
participant who inserted the template.

## 11. Organisation webhook

Each Organisation may store one webhook URL. Any owner can manage it from the
Space Settings menu and can choose **Send this Space now**. Because the
setting belongs to the Organisation, changing it from one Space changes the
destination used by every Space in that Organisation.

### Configure from a trusted partner backend

The partner backend can read or replace the Organisation-wide setting using a
fresh owner-signed `el1` assertion with `organisation_admin: true`. The
assertion's Organisation must match the URL path. URL-encode the external
Organisation key when constructing the path.

```text
GET /api/v1/organisations/<organisation-key>/webhook
PUT /api/v1/organisations/<organisation-key>/webhook
```

```http
PUT /api/v1/organisations/acme-learning/webhook
Host: your-spacescale.example
Authorization: Bearer <fresh-owner-admin-el1-assertion>
Content-Type: application/json

{"webhookUrl":"https://partner.example/webhooks/spacescale"}
```

Use `{"webhookUrl":null}` to clear it. `GET` and successful `PUT` return:

```json
{
  "organisationId": "o_AAAAAAAAAAAAAAAAAAAAAA",
  "webhookUrl": "https://partner.example/webhooks/spacescale",
  "updatedBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "updatedAt": 1786156200000
}
```

`updatedBy` is the opaque actor derived from the assertion's `participant_id`.
The external settings call does not expose or require the Worker-only derivation
key.

Webhook destinations are limited to 2,048 UTF-8 bytes and a public HTTPS
hostname on the default HTTPS port. Credentials, fragments, IP-literal hosts,
single-label/private hosts, and names ending in `.localhost`, `.local`,
`.internal`, `.lan`, `.home.arpa`, `.onion`, `.test`, or `.invalid` are rejected.
The URL's exact origin must also appear in the deployment's
`WEBHOOK_ALLOWED_ORIGINS`; an unapproved origin returns
`403 WEBHOOK_ORIGIN_NOT_ALLOWED`. A missing/malformed deployment policy rejects
configuration or delivery rather than silently broadening access.

### Configure or send from an owner session

The board-facing routes are:

```text
GET   /api/v1/boards/<board-id>/organisation/settings
PATCH /api/v1/boards/<board-id>/organisation/settings
POST  /api/v1/boards/<board-id>/organisation/webhook
```

Set or clear the destination:

```json
{
  "webhookUrl": "https://partner.example/webhooks/spacescale"
}
```

```json
{
  "webhookUrl": null
}
```

`GET` and successful `PATCH` return the same fields as the server-to-server
settings response above. A non-Organisation board returns null setting fields
from `GET` and rejects modification/sending.

Only an active owner may read/change the Organisation webhook setting or send a
board. The send action has no request body and requires a caller-generated
`Idempotency-Key` header of 16–128 characters from `[A-Za-z0-9._:-]`, normally a
UUID. Repeating the same key for the same owner and board returns the recorded
receipt instead of sending twice.

```http
POST /api/v1/boards/b_xxxxxxxxxxxxxxxxxxxxxx/organisation/webhook
Idempotency-Key: 018f0000-0000-7000-8000-000000000201
```

It captures an authoritative attributed snapshot—including external
`participantId` values—and makes one HTTPS delivery to the configured URL. A
successful trigger returns delivery metadata:

```json
{
  "delivery": {
    "id": "whd_AAAAAAAAAAAAAAAAAAAAAA",
    "event": "board.exported",
    "createdAt": 1786156200000,
    "responseStatus": 204
  },
  "idempotentReplay": false
}
```

### Webhook request

```http
POST /webhooks/spacescale HTTP/1.1
Content-Type: application/json; charset=utf-8
User-Agent: SpaceScale-Webhook/1.0
X-SpaceScale-Webhook-Id: whd_AAAAAAAAAAAAAAAAAAAAAA
X-SpaceScale-Webhook-Timestamp: 1786156200
X-SpaceScale-Webhook-Key-Id: 2026-08
X-SpaceScale-Webhook-Signature: v1=<base64url-hmac-sha256>
```

Body:

```json
{
  "event": "board.exported",
  "version": 1,
  "deliveryId": "whd_AAAAAAAAAAAAAAAAAAAAAA",
  "createdAt": 1786156200000,
  "organisation": {
    "id": "o_AAAAAAAAAAAAAAAAAAAAAA"
  },
  "board": {
    "id": "b_xxxxxxxxxxxxxxxxxxxxxx",
    "title": "Peer feedback",
    "seq": 84
  },
  "export": {
    "format": "cf-whiteboard-attributed-json",
    "version": 1,
    "board": {
      "id": "b_xxxxxxxxxxxxxxxxxxxxxx",
      "title": "Peer feedback",
      "seq": 84,
      "stateCreatedAt": 1786156200000
    },
    "participants": [],
    "objects": []
  }
}
```

`export` has exactly the attributed export structure from section 8.

The signature input is the UTF-8 bytes of:

```text
v1.<X-SpaceScale-Webhook-Timestamp>.<raw request body>
```

It is HMAC-SHA256 with the Organisation's current signing key, encoded as
unpadded base64url, and prefixed with `v1=` in the header. Verify the signature
against the raw body before parsing JSON or performing side effects.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySpaceScaleWebhook({ rawBody, headers, keysById }) {
  const deliveryId = headers.get("x-spacescale-webhook-id");
  const timestamp = headers.get("x-spacescale-webhook-timestamp");
  const keyId = headers.get("x-spacescale-webhook-key-id");
  const supplied = headers.get("x-spacescale-webhook-signature");
  const signingKey = keyId === null ? undefined : keysById[keyId];

  if (!deliveryId || !timestamp || !keyId || !signingKey || !supplied?.startsWith("v1=")) {
    throw new Error("Invalid SpaceScale webhook headers");
  }
  if (!/^\d+$/.test(timestamp)) throw new Error("Invalid webhook timestamp");

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (ageSeconds > 5 * 60) throw new Error("Stale webhook");

  const expected = createHmac("sha256", signingKey)
    .update(`v1.${timestamp}.`)
    .update(rawBody)
    .digest();
  const actual = Buffer.from(supplied.slice(3), "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid webhook signature");
  }

  // Enforce idempotency with a unique database key before processing.
  return { deliveryId, body: JSON.parse(rawBody.toString("utf8")) };
}
```

Return any `2xx` response only after safely accepting the delivery. Store
`deliveryId` with a unique constraint so a repeated request cannot duplicate
partner-side effects. Keep current and previous Organisation signing keys in
the receiver during rotation and choose with the key-ID header.

If the destination is missing, invalid, unreachable, or returns a non-2xx
status, the owner action returns an error instead of reporting success. Delivery
uses a ten-second timeout, does not follow redirects, and does not consume the
response body. The trigger performs one synchronous attempt. If a timeout or
network failure leaves the outcome ambiguous, retry the API request with the
same `Idempotency-Key`; this keeps the delivery ID stable so the receiver can
safely deduplicate it. Use a new key only for an intentional fresh export. The
standard error envelope uses
`WEBHOOK_NOT_CONFIGURED` when no destination exists and
`WEBHOOK_DELIVERY_FAILED` for network, timeout, redirect, and non-2xx failures.

## 12. Canonical BoardItem reference

The `items` array in canonical exports, initial imports, attributed exports, and
Organisation templates contains the following discriminated union.

Every item has the server fields `id`, `kind`, `z`, `version`, `createdBy`,
`style`, `transform`, and `geometry`. The valid style and geometry are selected
by the item's `kind`, as shown in the complete examples below. Items may also
carry `groupId` and `sectionId` relationship fields.

- `id` is a canonical UUID or canonical lowercase-prefixed base64url ID.
  SpaceScale-produced `createdBy` values are opaque Participant IDs in the form
  `a_` plus 22 base64url characters, which is also the form required by URL
  import.
- `z` is a unique non-negative safe integer paint order; higher values paint on
  top. `version` is a non-negative safe integer.
- `transform` is the SVG affine matrix `[a,b,c,d,e,f]`. Identity is
  `[1,0,0,1,0,0]`; translation uses `e,f`; uniform scale may be represented by
  `[s,0,0,s,e,f]`; rotation may be represented by
  `[cosθ,sinθ,-sinθ,cosθ,e,f]`. SpaceScale composes these values around the
  selected object pivot, so exports preserve combined scale, rotation, and
  translation without changing immutable image asset metadata.
- Colors are lowercase `#rrggbb`; opacity is `0.1..1`; stroke width is
  `1..100`; text sizes are `8..256`.
- Coordinates/dimensions are finite, canonicalised to two decimal places, and
  bounded by the protocol. Widths/heights are non-negative.
- Text font family is `sans`, `serif`, `handwritten`, or `mono`.
- Text-bearing styles may use `fontWeight` (`normal` or `bold`), `fontStyle`
  (`normal` or `italic`), and `textDecoration` (`none` or `underline`). Text,
  sticky, table, and Section styles support these fields. Sticky, table, and
  Section styles also support `fontFamily`.
- `groupId` identifies an explicit user-created group. Grouped items move and
  copy together; copying creates a fresh group ID for the copies.
- `sectionId` identifies the containing Section (`zone` item). Moving or copying
  a Section includes its current members. Resizing changes the Section frame
  only, then membership is recalculated from complete geometric containment.
  When nested Sections overlap, a newly created item joins the highest painted
  (`z`) containing Section.
- Explicit `http://` and `https://` URLs in rendered text are clickable in the
  editor and view-only viewer. Links are derived from ordinary text at render
  time; no separate link object is stored.
- `visiblePaths`, when present on an outline, is the surviving geometry after a
  partial erase. It contains 1–256 paths, at least two distinct adjacent points
  per path, and at most 10,000 points in total.

The examples below are complete valid canonical items. Give each item a unique
`id` and `z` when combining examples.

### Pencil

```json
{
  "id": "018f0000-0000-7000-8000-000000000101",
  "kind": "pencil",
  "z": 1,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "stroke", "color": "#1f2937", "width": 4, "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "points": [[80, 100], [96, 92], [112, 105], [130, 90]] }
}
```

Pencil geometry requires 2–10,000 distinct adjacent points. It may additionally
contain `visiblePaths` after partial erasure.

### Line

```json
{
  "id": "018f0000-0000-7000-8000-000000000102",
  "kind": "line",
  "z": 2,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "line", "color": "#2563eb", "width": 3, "opacity": 1, "arrowhead": "arrow" },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": {
    "x1": 120,
    "y1": 250,
    "x2": 330,
    "y2": 130,
    "visiblePaths": [[[120, 250], [205, 201]], [[235, 184], [330, 130]]]
  }
}
```

`arrowhead` is `none` or `arrow`. Snapping is stored simply as the resulting
coordinates; it does not create a persistent connector relationship.

### Rectangle and square

```json
{
  "id": "018f0000-0000-7000-8000-000000000103",
  "kind": "rectangle",
  "z": 3,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "stroke", "color": "#f97316", "width": 3, "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 80, "y": 320, "width": 240, "height": 140, "shape": "rectangle" }
}
```

```json
{
  "id": "018f0000-0000-7000-8000-000000000104",
  "kind": "rectangle",
  "z": 4,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "stroke", "color": "#14b8a6", "width": 3, "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 360, "y": 320, "width": 140, "height": 140, "shape": "square" }
}
```

A square must have equal `width` and `height`. Both variants may include
`visiblePaths`.

### Circle/ellipse

```json
{
  "id": "018f0000-0000-7000-8000-000000000105",
  "kind": "ellipse",
  "z": 5,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "stroke", "color": "#7c3aed", "width": 3, "opacity": 0.9 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 540, "y": 320, "width": 150, "height": 150 }
}
```

The `circle` feature creates an `ellipse` item; equal width and height produce a
circle. Ellipse geometry may include `visiblePaths`.

### Polygon: triangle, rhombus, pentagon, or hexagon

```json
{
  "id": "018f0000-0000-7000-8000-000000000106",
  "kind": "polygon",
  "z": 6,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "stroke", "color": "#dc2626", "width": 3, "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 80, "y": 500, "width": 180, "height": 150, "polygon": "triangle" }
}
```

The `polygon` discriminator is exactly `triangle`, `rhombus`, `pentagon`, or
`hexagon`. Replace the example value to create each corresponding shape. Polygon
geometry may include `visiblePaths`.

### Protractor

```json
{
  "id": "018f0000-0000-7000-8000-000000000107",
  "kind": "protractor",
  "z": 7,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "protractor", "color": "#7c3aed", "opacity": 0.8 },
  "transform": [0.866025, 0.5, -0.5, 0.866025, 420, 620],
  "geometry": { "radius": 180 }
}
```

The protractor is centred at local `[0,0]`, has a 180° baseline, and exposes
5° snap marks. Translation/rotation belongs in `transform`.

### Text

```json
{
  "id": "018f0000-0000-7000-8000-000000000108",
  "kind": "text",
  "z": 8,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "text", "color": "#1f2937", "fontSize": 28, "fontFamily": "handwritten", "fontWeight": "bold", "fontStyle": "italic", "textDecoration": "underline", "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 80, "y": 740, "text": "Explain your construction" }
}
```

Canvas text is limited to 5,000 Unicode code points.

### Sticky note

```json
{
  "id": "018f0000-0000-7000-8000-000000000109",
  "kind": "sticky",
  "z": 9,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "sticky", "fill": "#fde68a", "textColor": "#1f2937", "fontSize": 18, "fontFamily": "serif", "fontWeight": "bold", "fontStyle": "normal", "textDecoration": "none", "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 80, "y": 790, "width": 220, "height": 160, "text": "My question" }
}
```

Sticky text is limited to 1,000 Unicode code points.

### Sticker/stamp

```json
{
  "id": "018f0000-0000-7000-8000-000000000110",
  "kind": "stamp",
  "z": 10,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "stamp", "color": "#ec4899", "opacity": 1 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": { "x": 350, "y": 850, "size": 32, "stamp": "heart" }
}
```

`stamp` is exactly `star`, `check`, `heart`, `question`, `smile`, or `sparkle`.
The `x,y` coordinate is the centre and `size` must be greater than zero.

### Image card

```json
{
  "id": "018f0000-0000-7000-8000-000000000111",
  "kind": "image",
  "z": 11,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": { "kind": "image", "opacity": 1, "radius": 12 },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": {
    "x": 420,
    "y": 780,
    "width": 320,
    "height": 180,
    "assetId": "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "alt": "Student diagram of two parallel lines",
    "mimeType": "image/png",
    "intrinsicWidth": 1280,
    "intrinsicHeight": 720
  }
}
```

This item is valid only when the named private asset already exists for that
board. Image items cannot be used in initial imports or Organisation templates.
MIME type is `image/png`, `image/jpeg`, `image/webp`, or `image/gif`; intrinsic
dimensions are positive integers up to 4,096 each and 16 million pixels total;
`alt` is optional and limited to 500 code points; radius is `0..256`.

### Table

```json
{
  "id": "018f0000-0000-7000-8000-000000000112",
  "kind": "table",
  "z": 12,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": {
    "kind": "table",
    "borderColor": "#64748b",
    "fill": "#ffffff",
    "headerFill": "#dbeafe",
    "textColor": "#1f2937",
    "fontSize": 16,
    "opacity": 1
  },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": {
    "x": 80,
    "y": 1000,
    "columnWidths": [180, 220],
    "rowHeights": [48, 72, 72],
    "cells": [
      ["Claim", "Evidence"],
      ["", ""],
      ["", ""]
    ],
    "headerRow": true
  }
}
```

Tables have 1–6 columns and 1–8 rows. Width/height comes from the positive
`columnWidths`/`rowHeights`. The rectangular `cells` matrix must match those
array lengths exactly. A cell is limited to 500 code points and the table to
8,000 total. `headerRow` is optional.

### Section

```json
{
  "id": "018f0000-0000-7000-8000-000000000113",
  "kind": "zone",
  "z": 13,
  "version": 1,
  "createdBy": "a_AAAAAAAAAAAAAAAAAAAAAA",
  "style": {
    "kind": "zone",
    "borderColor": "#60a5fa",
    "fill": "#eff6ff",
    "textColor": "#1e3a8a",
    "fontSize": 20,
    "opacity": 0.8
  },
  "transform": [1, 0, 0, 1, 0, 0],
  "geometry": {
    "x": 40,
    "y": 1220,
    "width": 760,
    "height": 420,
    "title": "Group A",
    "locked": false
  }
}
```

The UI calls this a **Section**; its durable JSON kind remains `zone`. Titles are
limited to 120 Unicode code points and are always rendered on the Section.
Contained items point back to this item's `id` through `sectionId`; canonical
and attributed exports also provide the derived top-level `sections` index with
the visible `name`, `locked` state, and `memberItemIds`.

An owner can set `geometry.locked` to `true` from the selected Section toolbar.
A locked Section and every item whose `sectionId` points to it are read-only for
all participants, including owners, regardless of who created each item. The
lock prevents edits, moves, transforms, copies, deletes, new items assigned to
the Section, history operations affecting it, and clearing the Space. An owner
must perform a pure unlock before any of those changes can continue. Only an
owner may change the lock state. Omitting `locked`, or setting it to `false`,
means the Section is unlocked.

## 13. HTTP errors and operational behavior

Non-2xx API responses use:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "The request is not allowed.",
    "requestId": "request-correlation-id",
    "details": {}
  }
}
```

`details` is optional. Preserve `requestId` in partner logs when asking for
support. Common codes include `BAD_REQUEST`, `AUTH_REQUIRED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`,
`TEMPORARILY_UNAVAILABLE`, `TURNSTILE_REQUIRED`, `TURNSTILE_FAILED`,
`STALE_ACL`, `STALE_BOARD`, `WEBHOOK_NOT_CONFIGURED`,
`WEBHOOK_ORIGIN_NOT_ALLOWED`, `WEBHOOK_DELIVERY_FAILED`, and `INTERNAL_ERROR`.

Treat `401` as an expired/invalid assertion and sign a new one. Do not retry
`400` or `403` without changing the request or authority. `428
TURNSTILE_REQUIRED` is handled automatically by the official browser client
and does not apply to Organisation assertions. Use bounded
exponential backoff for `429`, `502`, and `503`. Canonical and attributed
exports are sequence-barrier snapshots and include `Cache-Control: no-store`;
they should not be served from an intermediary cache.

## 14. Partner launch checklist

- Use a unique stable `organisation_id` and preserve the Worker-only derivation
  key for the lifetime of that Organisation.
- Store only `key_id` and the current signing key in the trusted partner backend.
- Generate a fresh participant-specific assertion; never expose the signing
  key or share one participant URL.
- Use the same stable `space_id` whenever participants should resume the same
  Space.
- Use one stable `participant_id` per real participant and put the person's
  current human name in `display_name`.
- Generate all first-launch URLs with the same desired feature patch.
- Put launch/import data in the fragment exactly as shown, never in query
  parameters.
- Add every iframe parent to `ALLOWED_ORIGINS` and allow SpaceScale in the
  parent's `frame-src` policy.
- Use an owner launch for initial import. Verify the import is under 1 MiB,
  contains no images, and has no more than 1,000 items.
- Persist the returned/exported opaque board ID with the partner's `space_id`
  for server-side export calls.
- Use a newly signed owner assertion for each server-side export request.
- Configure the Organisation webhook from the trusted backend or an owner
  session, ensure its exact origin is present in `WEBHOOK_ALLOWED_ORIGINS`,
  verify webhook HMAC over the raw body, reject stale timestamps, and
  deduplicate `deliveryId`.
- Ask analytical questions from attributed export `content`, not merely the
  visual `item`, and remember that it is a current-state snapshot rather than a
  complete edit-history log.
