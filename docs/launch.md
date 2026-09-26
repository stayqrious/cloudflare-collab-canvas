# First launch

This is the one-time runbook for launching SpaceScale on a Cloudflare account
with the GitHub deployment workflow. It replaces the earlier installation (a
Worker deployed by Cloudflare Workers Builds from a committed `wrangler.jsonc`)
with a fresh one whose Worker and bucket names derive from `DEPLOYMENT_NAME`.
**No board from the earlier installation carries over**: the new Worker is a new
Durable Object namespace and the new buckets start empty.

After this, every push to `main` deploys production automatically once
`npm run check` passes. Nothing is ever set on the Worker by hand.

## 1. Values that can never change after launch

Choose these once. Changing any of them later strands every existing board,
because each one either names the storage that holds the boards or derives the
identifiers used to find them.

| Value | Where | Recommended | Why it is permanent |
| --- | --- | --- | --- |
| Cloudflare account | `CLOUDFLARE_ACCOUNT_ID` secret | The account that owns the site's DNS zone | Durable Objects and R2 buckets cannot move between accounts. |
| `DEPLOYMENT_NAME` | GitHub `production` variable | `spacescale` | Derives the Worker (`spacescale-production`) and both buckets (`spacescale-production-snapshots`, `spacescale-production-assets`). A different name is a different Worker, so a different Durable Object namespace, and empty buckets. 3–42 characters: lowercase letters, digits, internal hyphens. |
| `R2_BUCKET_JURISDICTION` | GitHub `production` variable | `default` | A bucket's jurisdiction is fixed when it is created. Use `eu` only if data must stay in the EU; `fedramp` only for FedRAMP accounts. |
| Each Organisation's `organisation_id` and `derivation_key` | Inside the `ORGANISATION_SIGNING_KEYS` secret | One entry per partner, keys from `openssl rand -base64 32` | They derive every Organisation board, participant, and recovery ID. Changing either makes that Organisation's Spaces unreachable. Launch-signing keys (`current`/`previous`) can rotate; these two cannot. |

`APP_HOSTNAME` can technically change, but every shared board link, partner
embed, and the Turnstile widget point at it, so treat it as fixed too.

These can change at any time by editing the GitHub environment and pushing to
`main` (or re-running the latest deploy):

- `ALLOWED_ORIGINS`, `WEBHOOK_ALLOWED_ORIGINS`
- `TURNSTILE_SITE_KEY` with `TURNSTILE_SECRET_KEY` (always from the same widget)
- `SESSION_SIGNING_KEY_CURRENT`: move the old value to
  `SESSION_SIGNING_KEY_PREVIOUS` first, or everyone is signed out
- Organisation launch-signing keys, following
  [signing-key rotation](../how_to_embed_me.md#signing-key-rotation)

## 2. Cloudflare

1. **Stop the old deployment path.** Dashboard → **Workers & Pages** → the
   current Worker (`cloudflare-collab-canvas`) → **Settings** → **Build** →
   **Disconnect** the Git repository. Do this before merging, so Workers Builds
   does not try to build a commit without `wrangler.jsonc`.
2. **Turnstile widget.** Dashboard → **Turnstile** → **Add widget**. Hostname:
   your `APP_HOSTNAME` (for example `spacescale.net`). Mode: **Invisible**. Copy
   the **Site Key** and **Secret Key**.
3. **API token.** Dashboard → **Manage Account** → **Account API Tokens** →
   **Create Token** → **Create Custom Token**, with exactly:
   - Account → **Workers Scripts: Edit** (target account only)
   - Account → **Workers R2 Storage: Edit** (target account only)
   - Zone → **Zone: Read** (only the zone that owns `APP_HOSTNAME`)
   - Zone → **WAF: Edit** (only that zone)

   Copy the token once.
4. **Account ID.** Dashboard → the account → **Account home** → copy
   **Account ID**.

The workflow creates the buckets, the Worker, and the Custom Domain itself. It
moves the hostname from the old Worker to the new one when it finalizes; you do
not need to detach it first.

## 3. Secrets

Generate every secret fresh for this installation:

```sh
openssl rand -base64 32   # SESSION_SIGNING_KEY_CURRENT
openssl rand -base64 32   # each Organisation derivation_key
openssl rand -base64 32   # each Organisation current launch key
```

`ORGANISATION_SIGNING_KEYS` is one line of JSON keyed by Organisation ID. Use a
real, stable ID for each partner (any string up to 120 characters, such as
`your-school`):

```json
{"your-org-id":{"derivation_key":"<base64>","current":{"key_id":"v1","key":"<base64>"},"previous":[]}}
```

`npm run deployment:secrets:init -- --env production` can generate both values
into an ignored `.env.production`. Its registry uses the Organisation ID
`hackathon`; rename that key to your real ID **before** launch, because the ID
is permanent. Share only an Organisation's `key_id` and `current.key` with that
partner, never its `derivation_key`.

## 4. GitHub

Repository → **Settings** → **Environments** → **New environment** →
`production`. Under **Deployment branches and tags**, allow only `main`.

Environment **secrets**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from step 2.4 |
| `CLOUDFLARE_API_TOKEN` | Token from step 2.3 |
| `SESSION_SIGNING_KEY_CURRENT` | Generated in step 3 |
| `ORGANISATION_SIGNING_KEYS` | The JSON registry from step 3 |
| `TURNSTILE_SECRET_KEY` | Secret Key from step 2.2 |
| `SESSION_SIGNING_KEY_PREVIOUS` | Leave unset at launch |

Environment **variables**:

| Name | Value |
| --- | --- |
| `DEPLOYMENT_NAME` | `spacescale` (permanent) |
| `R2_BUCKET_JURISDICTION` | `default` (permanent) |
| `APP_HOSTNAME` | `spacescale.net`, without scheme or slash |
| `TURNSTILE_SITE_KEY` | Site Key from step 2.2 |
| `ALLOWED_ORIGINS` | Comma-separated `https://` origins of the pages that embed SpaceScale, or leave blank to allow none |
| `WEBHOOK_ALLOWED_ORIGINS` | Comma-separated `https://` origins of approved webhook receivers, or blank |

`BOARD_CREATION_ENABLED` and `TURNSTILE_ENABLED` are fixed to `true` for
production in `.github/workflows/deploy.yml`.

A `staging` environment is optional. If you want one, repeat this section with a
separate token, different keys, `TURNSTILE_SECRET_KEY` unset, and its own
hostname, then push to a `staging` branch. It uses the same `DEPLOYMENT_NAME`
with `-staging` resources, so it can never touch production data.

## 5. Launch

1. Merge the pull request into `main`. The **Deploy** workflow runs
   `npm run check`, then the `production` job: it creates both buckets, uploads
   the Worker with all its secrets, deploys it at 100%, attaches `APP_HOSTNAME`,
   and probes `/healthz`.
2. Open `https://<APP_HOSTNAME>`, create a Space, and check drawing, a sticky
   note, a text box with a formula such as `\(x^2\)`, an image upload, and a
   comment. Open the invite link in a second browser to see changes arrive live.
3. AI tools are off in every new Space. Turn them on per Space under
   **Settings → Tool permissions → AI tools** only where the school has approved
   it (see [classroom AI safety](classroom-ai-safety.md)).

## 6. Remove the old installation

Once the new site is verified, delete what the earlier installation left behind:

- Worker `cloudflare-collab-canvas` (this deletes its Durable Objects and boards)
- R2 buckets `collab-canvas-snapshots` and `collab-canvas-assets` (empty each
  bucket first; Cloudflare only deletes empty buckets)
