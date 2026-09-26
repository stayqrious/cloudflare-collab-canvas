# Cloudflare Collab Canvas

A secure collaborative SVG whiteboard built for Cloudflare Workers, Workers
Static Assets, SQLite-backed Durable Objects, R2, and Turnstile.

The browser renders gestures immediately, while one `BoardRoom` Durable Object
per board validates, commits, sequences, and broadcasts every durable action
through the shared board reducer. SQLite is authoritative; private R2 objects
provide immutable recovery checkpoints and named snapshots.

## Space collaboration tools

Alongside freehand drawing, shapes, and plain text, the board supports durable
sticky notes for brainstorming, exit tickets, sorting, and feedback. Choose
**Sticky note** or press `N`, click the board, and type immediately. A note may
be left empty, uses a 180 × 140 board-unit default size, and can be recolored
with the six SpaceScale presets while creating it or after selecting it. Saved
sticky notes, image cards, tables, and sections expose direct resize handles.

Sticky notes participate in the same authoritative collaboration pipeline as
every other board item: they can be selected, moved, copied, deleted, undone,
redone, restored from snapshots, replayed from the offline outbox, and exported
to canonical JSON or safe SVG. Double-click a note—or double-tap it with the
select tool—to edit its wrapped text.

For quick visual feedback, choose **Stamp** or press `K`. Pick a star, check,
heart, question mark, smile, or sparkle in the palette, choose a colour, then
click or tap the board to place a compact 36-unit stamp. Stamps are local SVG
marks with accessible labels and no external image dependency.

Stamps are durable board items too: every participant sees them in real time,
and they support selection, movement, copy/delete, undo/redo, offline recovery,
snapshots, and JSON/SVG export.

Saved sticky notes, image cards, and stamps show the creator's initials. Hovering
the item reveals the creator's signed display name. The Worker uses only an
opaque actor ID for durable attribution; it does not store or expose the raw
stable user identifier.

Space owners can choose **Attributed data JSON** from the export menu to download
the current authoritative objects together with participant names and normalized
text attribution. Creator and content author are reported separately: for a
sticky, text item, image description, or section title, the responsible user is the
last participant who authored the current value; table cells are attributed
individually. The same owner-only data is available to trusted backends at
`GET /api/v1/boards/<board-id>/export.attributed.json`. It contains opaque actor
IDs and display names, never raw email addresses or `participant_id` values.

Owners can also enable private **Image cards** for a board. Editors then upload,
paste, or drop PNG, JPEG, WebP, and static GIF images; the browser removes photo
metadata before upload and the Worker validates the decoded format, dimensions,
content hash, role, lock state, and per-board quotas. Only immutable asset
metadata enters board actions and snapshots. Raw bytes stay in the private
`BOARD_ASSETS` R2 binding and are fetched through authenticated board URLs.

Image cards use contain sizing, loading/error fallbacks, editable alt text, and
the same selection, movement, copy/delete, persistence, and real-time controls
as other items. Safe SVG export uses a placeholder rather than leaking a private
asset URL or identifier.

For lightweight learning grids, choose **Table** or press `G`, select 1–6
columns and 1–8 rows in the blocking chooser, optionally enable a header row,
then choose a location on the board. Placement returns to **Select**. A selected
table exposes a lower-right whole-table handle plus draggable row and column
edge grips. Each cell contains plain text only; double-click or double-tap a
cell (or press `Enter`/`F2` on a selected table) to edit it. Tables use the same
real-time, role/lock, copy/delete, snapshot, replay, and safe JSON/SVG export
behavior as the other durable board items.

Owners and editors can select **Follow me** to share their live canvas position
and zoom with the Space, including while drawing is locked. Participants may
press `Esc` or choose **Stop** to leave that Spotlight session; a later session
can be followed normally. Spotlight traffic is ephemeral and never enters board
history, snapshots, exports, or the offline outbox.

The **Templates** menu includes five built-in starter layouts—Exit ticket,
K-W-L, Sort it, Pair share, and Vote with stamps—as ordinary attributed item
batches. Owners of an organisation-managed Space can also save a selection as
an organisation template. Those templates appear in every Space signed for the
same Organisation and remain isolated from every other Organisation.
Vote totals are derived live from each participant's latest stamp in the vote
table and are not stored in board history or exports. Only owners receive the
bulk **Clear votes** action; the underlying stamps remain ordinary board items.

Choose **Section** or press `Z` to add a labelled 520 × 320 work area. Its title
and border are selectable while the interior remains transparent to items
inside it. A selected section has a lower-right handle for changing its width and
height. Multi-selection also offers atomic **Arrange** actions to align or
distribute items and tidy selected sticky notes into a deterministic grid.

Choose **Line** or press `L` to draw a line, then enable **End arrow** when a
one-way connector is useful. New line endpoints snap to nearby cardinal points
on shapes, sticky notes, tables, image cards, and sections. V1 stores the snapped
coordinates as ordinary line geometry, so moving the target later does not move
the connector automatically.

AI assistance remains unimplemented and disabled. Any future classroom AI
feature must pass the [classroom AI safety and implementation
gate](docs/classroom-ai-safety.md) before code or rollout.

## Local development

Requirements: Node.js 22.19 or newer. Local development uses Miniflare-backed
Durable Objects and R2 plus committed, local-only signing values. It does not
need a Cloudflare account, API token, account ID, `.env`, or `.dev.vars`.

```sh
npm install
npm run dev
```

The application starts at `http://localhost:8787`. For the browser suite, install
the configured browsers once; the test command builds the web assets and starts
the same credential-free local Worker automatically:

```sh
npx playwright install
npm run test:e2e
```

Useful checks:

```sh
npm run typecheck
npm test
npm run test:edge
npm run test:e2e
npm run load:smoke
npm run security:scan
npm run cf:types
npm run build
npm run check
```

Run the focused checks relevant to a change during normal development. The full
`npm run check` and Playwright suites are available on demand and are not release
gates.

## Cloudflare setup

Cloudflare credentials are needed only for provisioning, validating, or deploying
a hosted environment. `.env.sample` is the source of truth for those configuration
names. Real secrets must never be committed, printed in logs, placed in
`wrangler.jsonc`, or exposed to browser code. Copy `.env.sample` to ignored `.env`
only when working with Cloudflare. Production secrets are installed with Wrangler
encrypted secrets or the Cloudflare deployment API.

### Variables

| Name | Purpose and acquisition |
| --- | --- |
| `R2_BUCKET_NAME` | Private checkpoint/export bucket. Use the committed environment-specific name. `npm run cf:bootstrap` creates it together with the separate private image bucket; no R2 S3 key is needed. |
| `TURNSTILE_SITE_KEY` | Production public site key from **Cloudflare Dashboard → Turnstile → widget → Site Key**. It may be exposed to the browser. Staging deliberately omits it because Turnstile is disabled there for browser automation. |
| `SESSION_SIGNING_KEY_CURRENT` | Secret HMAC key for device sessions. Generate independently per environment with `openssl rand -base64 32`. |
| `SESSION_SIGNING_KEY_PREVIOUS` | Optional prior session key, accepted only during rotation. Leave empty on a new installation. |
| `ORGANISATION_SIGNING_KEYS` | Secret JSON registry of Organisation-specific HMAC keys. Each entry has a stable `derivation_key`, a `current` launch key with `key_id`, and optional `previous` keys for rotation. Generate every key independently with `openssl rand -base64 32`. |
| `APP_HOSTNAME` | Public hostname only—no scheme, path, query, or trailing slash. Example: `whiteboard.example.com` or a `workers.dev` hostname. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins allowed to embed `/embed`. Missing, blank, or invalid configuration denies all framing; a literal `*` explicitly allows every parent. |
| `WEBHOOK_ALLOWED_ORIGINS` | Comma-separated exact public HTTPS origins approved to receive attributed board webhooks. Missing or blank denies all webhook configuration/delivery; wildcards are not supported. |
| `BOARD_CREATION_ENABLED` | Public fail-closed operational switch. `true` permits new boards; `false` preserves existing-board read/reconnect/export routes while rejecting creation. |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from **Dashboard → account → Account home/Overview**. It is an identifier, not a cryptographic secret. |
| `CLOUDFLARE_API_TOKEN` | Secret Cloudflare management API token used by bootstrap/CI; it is not an R2 S3 credential. Creation and scope are below. |
| `TURNSTILE_SECRET_KEY` | Production secret Siteverify key from **Dashboard → Turnstile → widget → Settings/details → Secret Key**. It must exist only server-side and is not installed on staging. |

### Exact API-token permissions

Create a custom token at **Cloudflare Dashboard → Manage Account → Account API
Tokens → Create Token → Create Custom Token**. For first-time bootstrap, grant:

| Resource scope | Dashboard permission | API permission name | Why |
| --- | --- | --- | --- |
| Include only the target account | Workers Scripts: Edit | `Workers Scripts Write` | Upload/deploy Worker modules and Static Assets, manage Worker secrets, and provision/bind the declared SQLite Durable Object class. |
| Include only the target account | Workers R2 Storage: Edit | `Workers R2 Storage Write` | Look up and create both private R2 buckets during bootstrap. |
| Include only the zone that owns `APP_HOSTNAME` | Zone: Read | `Zone Read` | Discover the exact active zone without committing its identifier. |
| Include only the zone that owns `APP_HOSTNAME` | WAF: Edit | `Zone WAF Write` | Create, verify, or repair the narrow server-API Super Bot Fight Mode skip rule. |

Do not add DNS, SSL, Workers Routes, D1, KV, Pages, Workers Tail, or broad account
permissions. Add a TTL and client-IP restriction when CI has stable egress.
Review the policy, create the token, copy it once, and store it only in the
local/CI secret store. If the Worker and DNS zone belong to different accounts,
the token must include the target Worker account plus the specific DNS zone.

Automatic bootstrap/deployment verifies or provisions both buckets and the WAF
rule on every run, so its environment token keeps all four permissions. A
separate deploy-only workflow that does not invoke bootstrap may retain only
Workers Scripts: Edit, but it will not provision buckets or repair WAF-rule
drift. Runtime object access comes from the private `BOARD_SNAPSHOTS` and
`BOARD_ASSETS` bindings, not an API or S3 credential.

Cloudflare does not support managing Turnstile widgets with account-owned API
tokens. Create the production widget in the dashboard, or use a short-lived
user API token with **Turnstile: Edit** (`Turnstile Sites Write`) scoped to the target account,
then revoke it. Runtime Siteverify uses only `TURNSTILE_SECRET_KEY`.

Classic Worker Routes need **Zone: Workers Routes: Edit** for the single zone;
automating their DNS record additionally needs **Zone: DNS: Edit**. A Worker
Custom Domain needs neither permission. `wrangler tail` should use a separate
operator token with **Workers Tail: Read**.

When enabled in production, the Turnstile widget uses action `board_create`
for creation,
`invitation_claim` for invitation links, and `recovery_claim` for owner
recovery. The Worker verifies the returned hostname and exact action through
Siteverify; tokens are single use and never reach a board Durable Object.

The committed public deployment contract is:

| Environment | Hostname | Snapshot bucket | Image bucket | Turnstile |
| --- | --- | --- | --- | --- |
| Development | `localhost` | `cloudflare-collab-canvas-dev-snapshots` | `cloudflare-collab-canvas-dev-assets` | Disabled |
| Staging | `staging-cloud-collab.spacescale.net` | `staging-cloud-collab` | `staging-cloud-collab-assets` | Disabled for browser automation |
| Production | `spacescale.net` | `collab-canvas-snapshots` | `collab-canvas-assets` | Adaptive, invisible; dedicated production widget |

Production and staging are separate Worker Custom Domains with `workers_dev`
disabled, so neither deployment can silently fall back to an unintended
hostname. Staging uses an isolated Worker, Durable Object namespace, R2 bucket,
and signing keys. It has no Turnstile site key or secret: the deployment fixes
`TURNSTILE_ENABLED=false` so Playwright and AI-driven browser checks can
exercise capability flows without interactive challenges. Never put production
data or credentials in this automation-only environment.

For production, configure the dedicated widget in **Invisible** mode, copy
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` from that same widget, and allow
exactly `spacescale.net`. The Worker asks for a token only when Cloudflare bot
signals or narrow browser-automation fallbacks classify the request as
suspicious. Normal sessions never load the widget. Do not pair a site key from
one widget with a secret from another. Confirm both custom domains are active
before validation.

### Provision and deploy

Verify the configured account, Workers access, R2 access, and Turnstile secret
without printing credential values:

```sh
npm run cf:check
```

`cf:check` also verifies that `APP_HOSTNAME` and `R2_BUCKET_NAME` identify one
committed environment. For production, a token that can read Turnstile Sites
also checks the widget site key, hostname allowlist, and returned secret pairing
without printing any of those values. The documented least-privilege
Workers/R2 token cannot read widgets, so a production
`manualDashboardConfirmationRequired` result means you must confirm the
same-widget key/secret and hostname allowlist in the Turnstile dashboard before
deployment. Staging has no widget pairing to confirm.

Provision an environment idempotently:

```sh
npm run cf:bootstrap -- --env production
```

The command reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the
process environment (the npm script loads ignored `.env` when present), verifies
the committed configuration, and creates both private buckets only when absent.
For each non-local hostname it discovers the owning zone, then creates or repairs
a first-position custom WAF rule matching only that exact host and
`/api/v1/organisations/*`. The rule skips only the Super Bot Fight Mode phase;
managed WAF rules, other custom rules, Browser Integrity Check, rate limiting,
and every browser/embed route remain enabled. Matching requests are logged in
Cloudflare Security Events and still need valid Organisation HMAC authentication
inside the Worker.

The command emits a machine-readable result without secrets, including
`serverApiBotBypass.created` and `serverApiBotBypass.updated`. Reruns against
correctly configured buckets and rules succeed without mutation. Cloudflare Free
plan Bot Fight Mode cannot be skipped by a WAF custom rule; use Super Bot Fight
Mode for a path exception, or disable Bot Fight Mode if it challenges legitimate
server clients.

To deploy only after successful provisioning:

```sh
npm run cf:bootstrap -- --env production --deploy
```

Cloudflare can also pull this repository, run `npm run check`, and deploy it
directly with Workers Builds. Runtime secrets stay on the Worker, so this path
does not need a GitHub deployment API token. The exact dashboard settings,
staging separation, and rollout tradeoffs are documented in
[docs/deployment-ci.md](docs/deployment-ci.md#cloudflare-workers-builds).

The retained GitHub Actions path is deliberately direct. A push to `staging` or
`main` checks out that exact SHA, idempotently creates or reuses both private R2
buckets, builds the web assets, uploads a Worker version, deploys it at 100%, and
makes a small five-attempt health probe. It does not wait for CI, require an
attestation or approval, stage a candidate, run load/browser suites, or automate
rollback. Focused development checks are the normal promotion criterion; moving
the same SHA through `staging` and then `main` is recommended but not enforced.
Full CI and Playwright are manual-only.

For GitHub deployments, add `ORGANISATION_SIGNING_KEYS` as an encrypted secret
in both the `staging` and `production` GitHub environments. The workflow uploads
it with each Worker version using Wrangler's secret file support. The commands
below remain useful for manual or Cloudflare-native deployments.

Install runtime secrets before the first production request:

```sh
npx wrangler secret put SESSION_SIGNING_KEY_CURRENT
npx wrangler secret put ORGANISATION_SIGNING_KEYS
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Install distinct staging secrets explicitly against the staging environment:

```sh
npx wrangler secret put SESSION_SIGNING_KEY_CURRENT --env staging
npx wrangler secret put ORGANISATION_SIGNING_KEYS --env staging
```

Before running either bootstrap/deploy command, set `.env` to the selected
environment's bucket and hostname. Staging uses `staging-cloud-collab` and
`staging-cloud-collab.spacescale.net`; it needs no Turnstile credentials.
Production uses `collab-canvas-snapshots`, `spacescale.net`, and its dedicated
widget credentials.

During signing-key rotation, install `SESSION_SIGNING_KEY_PREVIOUS`, deploy code
that accepts both keys, rotate the current key, wait past the session window,
then remove the previous key.

For staging and production use distinct Worker deployments, Durable Object
namespaces, R2 buckets, session keys, Organisation key registries, and origins.
The production widget is production-only. Never copy production data into local
development or staging.

## Architecture

```text
Browser (TypeScript + SVG)
  ├─ static shell → Workers Static Assets
  └─ HTTP/WebSocket → gateway Worker
                         ├─ creation/claim abuse controls
                         └─ BoardRoom Durable Object per board
                              ├─ authoritative SQLite state/actions/ACL
                              └─ private R2 recovery snapshots and image assets
```

The BoardRoom's private SQLite database is the sole authority for whether a
board exists and for its current state. Ordinary board requests never depend on
R2 availability. The gateway applies bounded creation and claim buckets.
Production capability-issuing flows require action-bound Turnstile; development
and the isolated automation-only staging environment deliberately disable it.

See [docs/operations.md](docs/operations.md) for deployment, recovery, quotas,
and incident procedures. GitHub environment settings, bucket provisioning, and
the lightweight release flow are in
[docs/deployment-ci.md](docs/deployment-ci.md).

Trusted-backend signing, Organisation and Space isolation, initial JSON import,
iframe setup, participant-owned editing, live owner controls, co-owners,
all feature flags, Organisation templates, export and board-deletion APIs,
every object format, and signed webhooks are documented in the single partner reference:
[how_to_embed_me.md](how_to_embed_me.md). Runnable parent-backend integrations
are available for
[JavaScript](examples/partner-integration.mjs) and
[Python](examples/partner_integration.py).
