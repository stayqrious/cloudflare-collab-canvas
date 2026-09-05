# Deployment and CI

This repository uses pull-request validation and branch protection for production
changes while retaining a lightweight direct deployment after merge.

## Workflows

`.github/workflows/ci.yml` runs for pull requests into `main`, pushes to `main`,
and manual `workflow_dispatch` requests. The automatic runs execute the full
repository check and verify generated Worker binding types. Playwright runs only
when the workflow is dispatched manually. Only the `validate` job is required
before a pull request can merge into `main`. Concurrency is grouped per event and
ref, so a new pull-request or `main` push run supersedes the outstanding run for
that same ref while manually dispatched browser runs are never cancelled by it.

`.github/workflows/deploy.yml` runs directly on pushes to `staging` and `main`.
Each job reads its target hostname and resource names from that GitHub
environment's variables; no resolved mapping is stored in the workflow.

Each job:

1. checks out the pushed `${{ github.sha }}`;
2. installs the pinned dependencies;
3. verifies the environment-scoped Cloudflare credentials;
4. idempotently creates or reuses the snapshot and private image R2 buckets;
5. builds the web assets;
6. uploads a Worker version;
7. deploys that version directly at 100%; and
8. makes up to five small `/healthz` requests that check only `ok` and the
   service identity.

The production deployment starts from the protected `main` push after the pull
request's approval and required checks. The deployment workflow does not wait for
the redundant post-merge CI run, exact-SHA attestations, candidate traffic, load
suites, convergence loops, automated rollback, or a schema-compatibility gate.
Fix forward and redeploy if a release has a defect.

Moving the same commit from `development` to `staging` and then `main` is
recommended for traceability, but the workflow does not enforce that order.

## GitHub environments

Create `staging` and `production` GitHub environments. They may point to
different Cloudflare accounts and should use distinct credentials.

| Environment | Kind | Name | Value |
| --- | --- | --- | --- |
| Staging | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the isolated staging Worker and buckets. |
| Staging | Secret | `CLOUDFLARE_API_TOKEN` | Staging account token. |
| Staging | Secret | `ORGANISATION_SIGNING_KEYS` | JSON registry uploaded as an encrypted Worker-version secret. |
| Staging | Variable | `DEPLOYMENT_NAME` | Lowercase installation name used to derive the isolated staging Worker and buckets. |
| Staging | Variable | `R2_BUCKET_JURISDICTION` | `default`, `eu`, or `fedramp`. |
| Staging | Variable | `APP_HOSTNAME` | Exact staging hostname. |
| Staging | Variable | `ALLOWED_ORIGINS` | Comma-separated iframe origins; blank denies all and `*` allows all. |
| Staging | Variable | `WEBHOOK_ALLOWED_ORIGINS` | Comma-separated exact HTTPS webhook receiver origins; blank denies all, with no wildcard support. |
| Production | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the production Worker and buckets. |
| Production | Secret | `CLOUDFLARE_API_TOKEN` | Production account token. |
| Production | Secret | `ORGANISATION_SIGNING_KEYS` | JSON registry uploaded as an encrypted Worker-version secret. |
| Production | Variable | `DEPLOYMENT_NAME` | Lowercase installation name used to derive the isolated production Worker and buckets. |
| Production | Variable | `R2_BUCKET_JURISDICTION` | `default`, `eu`, or `fedramp`. |
| Production | Variable | `APP_HOSTNAME` | Exact production hostname. |
| Production | Variable | `TURNSTILE_SITE_KEY` | Public key for the production Turnstile widget. |
| Production | Variable | `ALLOWED_ORIGINS` | Comma-separated iframe origins; blank denies all and `*` allows all. |
| Production | Variable | `WEBHOOK_ALLOWED_ORIGINS` | Comma-separated exact HTTPS webhook receiver origins; blank denies all, with no wildcard support. |

Because every deployment verifies or provisions both R2 buckets, each API token
needs these account permissions:

- **Workers Scripts: Edit**
- **Workers R2 Storage: Edit**

Correct existing private buckets are reused without mutation. Bucket bootstrap
also rejects a bucket with an enabled `r2.dev` or custom public domain.

The workflow passes `ORGANISATION_SIGNING_KEYS` through Wrangler's
`--secrets-file`; it is encrypted as a Worker-version secret and never written
to the repository or logs. Install the remaining Worker runtime secrets once
with Wrangler or the Cloudflare dashboard:

| Worker | Required runtime secrets |
| --- | --- |
| Staging | `SESSION_SIGNING_KEY_CURRENT`; Organisation registry supplied by the GitHub environment |
| Production | `SESSION_SIGNING_KEY_CURRENT`, `TURNSTILE_SECRET_KEY`; Organisation registry supplied by the GitHub environment |

`SESSION_SIGNING_KEY_PREVIOUS` is optional during a controlled session-key
rotation. Never share session or Organisation signing keys across environments.

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

After the required `validate` check passes and at least one reviewer approves,
merge the pull request. The resulting `main` push triggers production deployment
and a second validation run. Dispatch CI manually when browser E2E coverage is
needed.

## Cloudflare Workers Builds

Workers Builds may pull the repository and deploy with secrets stored at the
Worker level. It remains an optional alternative. Do not enable it for a Worker
that is also targeted by the GitHub deployment workflow, or both systems may
race to deploy different commits.
