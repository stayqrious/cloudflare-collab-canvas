# Deployment and CI

SpaceScale supports **Cloudflare Workers Builds** and **GitHub Actions**. Choose
one automatic provider for both environments. Both call the same deployment
command, so switching providers preserves the Worker, Durable Objects, buckets,
domains, and signing keys.

| Branch | Environment | Worker when `DEPLOYMENT_NAME=spacescale` |
| --- | --- | --- |
| `staging` | staging | `spacescale-staging` |
| `main` | production | `spacescale-production` |

## Shared deployment

```sh
npm run deployment:check
npm run deployment:deploy -- --env staging
# For production, use --env production instead.
```

`deployment:check` runs the full repository check (lint, types, unit and edge
tests, production dry-run build, protocol and security checks), then verifies
Cloudflare binding types. It does not contact deployment APIs.

`deployment:deploy` validates configuration and runtime secrets before making
changes, initializes private R2 buckets and the server-API WAF rule, builds the
web assets, and runs `wrangler deploy` against the generated environment config.
This supports initial Worker and Durable Object creation as well as updates.
It uploads runtime secrets with the code using a temporary mode-0600 secrets
file, removes that file even if upload fails, finalizes the Custom Domain only
after deployment succeeds, and probes `/healthz` up to five times. A failed
health probe fails the deployment command; it does not automatically roll back.

Provide configuration through the selected provider's build environment or
ignored `.env.staging` / `.env.production` files. The same names and required
values apply to both providers; see [launch.md](launch.md). Keep each
environment's secrets, hostname, Durable Objects, and R2 buckets separate.

## Cloudflare Workers Builds (no automatic GitHub runner usage)

1. Complete the Cloudflare, key, and configuration setup in [launch.md](launch.md).
   Workers Builds currently supports **user-owned API tokens**. Select a custom
   token with Workers Scripts Edit, Workers R2 Storage Edit, Zone Read, WAF Edit,
   and Workers Routes Edit for the target account/zone. The deployment scripts
   accept both user-owned and account-owned tokens; the latter also work for
   local and GitHub deployment. If managing Builds connections through the API,
   also grant Account **Workers CI Edit** (called `Workers CI Write` in the API).
2. If the two Workers do not exist yet, bootstrap each once from a trusted local
   checkout. Use Node 22.19.0 or newer, `npm ci`, and `npm run deployment:check`,
   then run `npm run deployment:deploy -- --env staging` and the production
   equivalent using their separate ignored environment files. These commands
   deploy and attach the configured hostnames; choose the initial cutover time
   deliberately. The prior installation's boards do not migrate automatically.
   If a hostname already belongs to another Worker, explicitly move its Custom
   Domain to the new Worker after deployment, then rerun the deployment command.
   Cloudflare rejects the initial attachment with HTTP 409 until that cutover;
   the script does not automatically take over another Worker's hostname.
3. In GitHub **Settings → Secrets and variables → Actions → Variables**, add
   the **repository variable** `AUTOMATION_PROVIDER=cloudflare`. This skips all
   automatic jobs in this repository's CI and Deploy workflows before a runner
   starts. Manual **CI → Run workflow** remains available and uses GitHub minutes.
4. In Cloudflare **Workers & Pages**, open each existing Worker, then
   **Settings → Build**, and connect the same GitHub repository. Use these settings:

   | Setting | Staging Worker | Production Worker |
   | --- | --- | --- |
   | Root directory | repository root | repository root |
   | Production branch | `staging` | `main` |
   | Build command | `npm run deployment:check` | `npm run deployment:check` |
   | Deploy command | `npm run deployment:deploy -- --env staging` | `npm run deployment:deploy -- --env production` |
   | Preview/non-production branch builds | disabled | disabled |

   "Production branch" is Cloudflare's name for the branch that deploys that
   particular Worker; selecting `staging` there does not affect the production Worker.
   Keep Node at 22.19.0 or newer. Cloudflare installs dependencies before the build.
   No committed Wrangler file is needed: the deploy script generates one and
   passes its explicit path to Wrangler. Do not use the default deploy command.
5. Add each environment's configuration under **Build variables and secrets**.
   Use the tables in [launch.md](launch.md), plus `TURNSTILE_ENABLED=false` for
   staging and `true` for production. Set `BOARD_CREATION_ENABLED=true` normally.
   Select the scoped token as the build's API token; provide `CLOUDFLARE_ACCOUNT_ID`
   as a build variable. Workers Builds supplies `CLOUDFLARE_API_TOKEN` from the
   selected token. Add the session/Organisation/Turnstile runtime secrets as
   **build secrets**: the shared script transfers them to encrypted Worker
   bindings on every deployment. Build secrets alone are not runtime bindings.
6. Trigger a staging build and verify its health and changed features. Merge
   the tested code into `main` when ready; Cloudflare deploys production.
7. Adjust branch protection to match the selected checks. Do not rely on skipped
   GitHub `validate`/`browser` jobs as validation. The configured Cloudflare build
   gates deployment with `deployment:check`; use required reviews and staging
   validation before merging. Browser E2E remains available locally with
   `npm run test:e2e` or through the manual GitHub CI workflow.

Disable preview builds on both Workers: this application uses persistent,
separate staging and production resources. The deploy command also rejects a
Workers Builds branch other than `staging` for staging or `main` for production.
It must not be used as a preview command against production storage.

Cloudflare builds have their own quota and timeout, not unlimited execution.
As of September 2026: Free includes 3,000 build minutes/month, Paid includes
6,000 then $0.005/minute; builds have a 20-minute timeout and each build variable
is limited to 5 KB. Keep the Organisation registry within that per-variable limit.
See [limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/).

Cloudflare references: [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [connecting multiple environment Workers](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/).

### Verify a production push

1. Record the current production `/healthz` response and its `versionId` before
   pushing. A healthy response alone does not prove that a new commit deployed.
2. Push the intended commit to `main`, then open the production Worker's build
   history. Confirm the build uses that commit and that validation and deployment
   both succeed. With `DEPLOYMENT_NAME=spacescale`, the connected Worker must be
   `spacescale-production`, including after a move from a legacy Worker name.
3. Check that the production Custom Domain still targets this Worker and that
   `/healthz` reports the version from the successful deployment. Skipped GitHub
   jobs are expected with `AUTOMATION_PROVIDER=cloudflare`; they do not confirm a
   Cloudflare build succeeded.
4. Open a disposable production board and verify editing, saved content after
   reload, a second participant, and view/edit permission changes. Run Playwright
   against the production URL with `PLAYWRIGHT_BASE_URL` set, and clean up test
   data where the flow supports deletion.

## GitHub Actions

Leave `AUTOMATION_PROVIDER` unset or set it to `github`. Disconnect Workers
Builds on the two target Workers before enabling automatic GitHub deployment.
This avoids independent builds racing to deploy different commits.

Create GitHub environments `staging` and `production`, with the variables and
secrets in [launch.md](launch.md). Restrict production deployment to `main`.
`.github/workflows/deploy.yml` validates every `staging`/`main` push with
`npm run check` and generated binding-type verification, then deploys that exact SHA through the shared command. Staging
has Turnstile disabled; production requires a real widget's site and secret keys.

`.github/workflows/ci.yml` validates pull requests into `main`, including binding-type
verification. Pushes use the Deploy workflow’s validation job, avoiding a duplicate
full check on every merge. Pull requests run Chromium and
mobile Chromium E2E; manual dispatch runs all browser projects. Require the
`validate` and `browser` pull-request checks when using this provider. Newer
runs supersede older automatic runs for the same event/ref.

To switch back to Cloudflare, set the repository variable to `cloudflare`, wait
for any in-flight GitHub deployments to finish, then enable the Workers Builds
connections. Preserve all deployment names, account IDs, jurisdictions, and
signing keys. Switching the build runner does not require fresh storage.
