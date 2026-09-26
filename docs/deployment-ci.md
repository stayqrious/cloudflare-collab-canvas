# Deployment and CI

This repository uses pull-request validation and branch protection for production
changes while retaining a lightweight direct deployment after merge.

## Workflows

`.github/workflows/ci.yml` runs for pull requests into `main`, pushes to `main`,
and manual `workflow_dispatch` requests. Every run executes the full repository
check and verifies generated Worker binding types. Pull requests also run the
Playwright suite in Chromium and mobile Chromium; a manual dispatch runs every
browser project. Require the `validate` and `browser` jobs before a pull request
can merge into `main`. Concurrency is grouped per event and
ref, so a new pull-request or `main` push run supersedes the outstanding run for
that same ref while manually dispatched browser runs are never cancelled by it.

`.github/workflows/deploy.yml` runs on every push to `staging` and `main`,
including direct pushes that skip a pull request. A `validate` job runs the full
`npm run check` first, and neither deploy job starts unless it passes. Each job
reads its target hostname and resource names from that GitHub environment's
variables; no resolved mapping is stored in the workflow.

Each deploy job:

1. checks out the pushed `${{ github.sha }}`;
2. installs the pinned dependencies;
3. verifies the environment-scoped Cloudflare credentials;
4. idempotently creates or reuses the snapshot and private image R2 buckets;
5. builds the web assets;
6. uploads a Worker version with every runtime secret from the GitHub environment;
7. deploys that version directly at 100%;
8. attaches the Custom Domain for `APP_HOSTNAME`, moving it from any other Worker;
   and
9. makes up to five small `/healthz` requests that check only `ok` and the
   service identity.

The deployment does not wait for exact-SHA attestations, candidate traffic, load
suites, convergence loops, automated rollback, or a schema-compatibility gate.
Fix forward and redeploy if a release has a defect. The first launch, and which
settings can never change afterwards, is in [launch.md](launch.md).

Moving the same commit through `staging` before `main` is recommended when a
staging environment exists, but the workflow does not enforce that order.

## GitHub environments

Create `staging` and `production` GitHub environments. They may point to
different Cloudflare accounts and should use distinct credentials.

| Environment | Kind | Name | Value |
| --- | --- | --- | --- |
| Staging | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the isolated staging Worker and buckets. |
| Staging | Secret | `CLOUDFLARE_API_TOKEN` | Staging account token. |
| Staging | Secret | `ORGANISATION_SIGNING_KEYS` | JSON registry uploaded as an encrypted Worker-version secret. |
| Staging | Secret | `SESSION_SIGNING_KEY_CURRENT` | Staging session signing key, uploaded with each version. |
| Staging | Secret | `SESSION_SIGNING_KEY_PREVIOUS` | Optional; only during a session-key rotation. |
| Staging | Variable | `DEPLOYMENT_NAME` | Lowercase installation name used to derive the isolated staging Worker and buckets. |
| Staging | Variable | `R2_BUCKET_JURISDICTION` | `default`, `eu`, or `fedramp`. |
| Staging | Variable | `APP_HOSTNAME` | Exact staging hostname. |
| Staging | Variable | `ALLOWED_ORIGINS` | Comma-separated iframe origins; blank denies all and `*` allows all. |
| Staging | Variable | `WEBHOOK_ALLOWED_ORIGINS` | Comma-separated exact HTTPS webhook receiver origins; blank denies all, with no wildcard support. |
| Production | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the production Worker and buckets. |
| Production | Secret | `CLOUDFLARE_API_TOKEN` | Production account token. |
| Production | Secret | `ORGANISATION_SIGNING_KEYS` | JSON registry uploaded as an encrypted Worker-version secret. |
| Production | Secret | `SESSION_SIGNING_KEY_CURRENT` | Production session signing key, uploaded with each version. |
| Production | Secret | `SESSION_SIGNING_KEY_PREVIOUS` | Optional; only during a session-key rotation. |
| Production | Secret | `TURNSTILE_SECRET_KEY` | Secret Key of the production Turnstile widget, uploaded with each version. |
| Production | Variable | `DEPLOYMENT_NAME` | Lowercase installation name used to derive the isolated production Worker and buckets. |
| Production | Variable | `R2_BUCKET_JURISDICTION` | `default`, `eu`, or `fedramp`. |
| Production | Variable | `APP_HOSTNAME` | Exact production hostname. |
| Production | Variable | `TURNSTILE_SITE_KEY` | Public key for the production Turnstile widget. |
| Production | Variable | `ALLOWED_ORIGINS` | Comma-separated iframe origins; blank denies all and `*` allows all. |
| Production | Variable | `WEBHOOK_ALLOWED_ORIGINS` | Comma-separated exact HTTPS webhook receiver origins; blank denies all, with no wildcard support. |

Because every deployment verifies or provisions both R2 buckets, the WAF rule,
and the Custom Domain, each API token needs:

- Account: **Workers Scripts: Edit**
- Account: **Workers R2 Storage: Edit**
- Zone (the zone that owns `APP_HOSTNAME`): **Zone: Read**
- Zone (the same zone): **WAF: Edit**

Correct existing private buckets are reused without mutation. Bucket bootstrap
also rejects a bucket with an enabled `r2.dev` or custom public domain.

The workflow passes every runtime secret through Wrangler's `--secrets-file`, so
each version carries its own complete set, encrypted, and nothing is set on the
Worker by hand. Blank optional secrets are left out. The file is written to the
runner's temporary directory with mode `0600` and never reaches the repository
or logs. Never share session or Organisation signing keys across environments.

## Environment isolation

The workflow runs `npm run deployment:init -- --env <environment>` after
checkout. That command validates the environment-scoped values, derives the
Worker and both bucket names, writes an ignored mode-`0600` Wrangler file, and
creates or verifies the private buckets. Wrangler upload and deploy commands
receive that generated file explicitly. Missing details stop the job before any
Cloudflare resource lookup and the error never echoes configured values.

Staging is deliberately automation-friendly. It has no Turnstile challenge so
Playwright and AI-driven testing can create disposable boards. Keep it isolated
from production data, signing keys, Durable Objects, and R2 buckets.

Production requires both `TURNSTILE_SITE_KEY` at deployment and
`TURNSTILE_SECRET_KEY` at runtime. Configure both from the same widget and allow
the configured `APP_HOSTNAME` on that widget. Set the widget mode to **Invisible**. The web
client loads it only after the Worker marks a request as suspicious.

## Normal release

Run the focused development checks appropriate to the change. Staging may still
be updated directly, but production changes go through a pull request:

```sh
git push origin development
git push origin development:staging
gh pr create --base main --head development
```

After the required `validate` and `browser` checks pass and at least one reviewer
approves, merge the pull request. The resulting `main` push runs the full check
again and then deploys production. Dispatch CI manually to run every browser
project.

## Cloudflare Workers Builds

Do not use Workers Builds with this repository. There is no committed Wrangler
configuration for it to build from (the configuration is generated per
environment), and a connected build would race the GitHub workflow for the same
Worker. If a Worker was connected before, disconnect it under **Workers & Pages →
the Worker → Settings → Build**.
