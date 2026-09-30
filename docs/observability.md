# Observability contract and runbook

This repository contains a reviewed, machine-validated observability **plan**. It does not claim
that a Cloudflare dashboard, saved query, alert evaluator, or notification destination has been
provisioned. `config/observability.json` is the source of truth for the application metrics in
specification section 20.2 and the seven thresholds in section 20.3.

Cloudflare's saved-query API persists a query definition. It does not, by itself, schedule the
query, evaluate an application-specific ratio, arrange a dashboard, or deliver a notification.
Those lifecycle steps remain explicit operator work.

## Repository checks

Validate the contract and exact thresholds:

```sh
npm run observability:check
```

Render the reviewed requests that could later be submitted to Cloudflare:

```sh
npm run --silent observability:plan > observability-plan.json
```

The plan command is deliberately offline. It never reads `CLOUDFLARE_API_TOKEN`, never calls
`fetch`, keeps `{account_id}` as a placeholder, redacts the authorization header, and has no apply
mode. `--apply`, `--execute`, `--provision`, and `--write` fail closed. The generated request body
for each query contains only the official `name`, `description`, and `parameters` fields accepted
by `POST /accounts/{account_id}/workers/observability/queries`. Repository-only chart guidance is
kept outside that body.

Do not commit the rendered plan if it has been annotated with account-specific IDs. The committed
configuration itself contains no account ID, API token, notification destination ID, board ID, or
user data.

## Data-readiness gate

Run this gate in staging before saving queries. Passing `npm run observability:check` proves only
that the declaration is internally consistent; it cannot prove that a deployed runtime emits the
declared fields.

1. Enable Workers Logs for every deployed environment at a head sampling rate of `1`. The
   setup-generated Wrangler configuration enables observability; confirm the effective target
   configuration before relying on its data.
2. Emit custom telemetry as a JavaScript object, for example `console.log({ event, ...fields })`.
   Do not pass `JSON.stringify(object)` to `console.log`: Cloudflare stores that as a message string
   rather than indexing the application fields.
3. Generate one staging example of every required event below. Use the Workers Observability
   telemetry keys endpoint or Query Builder autocomplete to confirm the exact field names and
   types before saving queries. A key missing from that discovery step is a release blocker for
   its chart.
4. Confirm invocation records expose `$workers.cpuTimeMs`, `$workers.wallTimeMs`,
   `$workers.executionModel`, `$workers.entrypoint`, and `$workers.outcome`. Durable Object records
   should identify the `BoardRoom` entrypoint and may expose `$workers.durableObjectId`; never copy
   the raw Durable Object ID into application logs. These invocation fields are useful for
   performance diagnosis, but `$workers.wallTimeMs` is not a substitute for Cloudflare's billed
   Durable Object duration metric.
5. Verify `boardIdHash` is a stable one-way SHA-256 digest suitable for correlation but cannot be
   converted back into the routable board ID. Raw board IDs, drawing data, text, tokens, cookies,
   actor names, IP addresses, and user agents are forbidden.
6. Check denominator integrity: each accepted socket has exactly one replay outcome, and each
   gateway or Durable Object HTTP invocation has exactly one normalized completion event. Missing
   denominators make the percentage alerts unsafe.
7. Confirm preview and presence frames are aggregated into `traffic.metrics`. Never produce a log
   event per ephemeral frame.

`safeLog` emits an indexed object. Gateway `http.request_completed` and `board.created` events are
runtime-ready; several Durable Object aggregate events and fields below are not yet emitted.
Until staging proves the full field coverage and denominator rules, the queries are schema-ready
but **not data-ready**.

Head sampling below `1`, account log-volume fallback sampling, ingestion delays, or dropped events
turn log-derived counts into estimates. In particular, do not sum `quota.daily` events and call the
result an account total. Each event is an eviction-safe cumulative estimate for one board, useful
for attribution and capacity modeling. Account-wide Worker requests, Durable Object billed usage
and duration, and SQLite usage must come from Cloudflare Metrics and Analytics, which owns the
billing semantics and sees every object. The application deliberately emits no synthetic account
aggregate and no active-duration proxy.

## Runtime event contract

Every custom event is an indexed object with `event`, `level`, epoch-millisecond `at`, and
`environment`. Include `requestId`, a one-way `boardIdHash`, `workerVersionId`,
`durableObjectVersion`, and
`protocolVersion` when applicable. Numeric field names keep one type across all event kinds:
HTTP completion uses `status`, WebSocket closure uses `closeCode`, and stable application outcome
codes use string `code`.

The complete machine-readable field list and cadence rules live under `runtimeContract` in
`config/observability.json`. The minimum chart-producing events are:

| Event | Required measurement fields | Emission rule |
| --- | --- | --- |
| `board.metrics` | `activeSockets`, `snapshotLagActions`, `snapshotLagMs`, `itemCount`, `storageBytesEstimate`, `itemLimitUtilization`, `storageLimitUtilization` | Changed gauge sample, rate-limited to once per active board per minute; always emit zero after the final disconnect |
| `traffic.metrics` | `previewFrames`, `commitFrames`, `sampleWindowMs` | Aggregated interval only |
| `command.accepted` / `command.rejected` | `actionKind`, string `result`, stable string `code`, `durationMs`; accepted also has `seq` | Once per durable command outcome |
| `broadcast.completed` | `fanout`, `sendFailures` | Once per durable action broadcast, including zero failures |
| `replay.completed` / `replay.unavailable` | `replayActions`, `replayBytes`, `resyncRequired`, `result`, `code` | Exactly one outcome per accepted connection, including zero-action replay |
| `storage.transaction_completed` | `durationMs`, `sqliteRowsRead`, `sqliteRowsWritten`, `result`, `code` | Once per durable command transaction, including typed rollback |
| `snapshot.completed` / `snapshot.failed` | `durationMs`, `r2BytesWritten`, `seq`, `result`, `code` | Once per R2 snapshot attempt |
| `quota.daily` | UTC-day cumulative incoming frames, modeled DO request units, SQLite rows, R2 operations and bytes written, actions, and snapshots | One persisted per-board sample; never an account aggregate |
| `http.request_completed` / `room.http_completed` | `executionComponent`, numeric `status`, `internalError`, `durationMs` | Exactly one mapped completion per handler invocation |

Retain the section 20.1 lifecycle events as well: `board.created`, `socket.connected`,
`socket.disconnected`, `membership.changed`, `rate_limit.triggered`, `room.overloaded`, and
`schema.migrated`. Their required privacy-safe fields are in the configuration.

`itemLimitUtilization` and `storageLimitUtilization` are ratios from `0` through `1`, not
percentages from `0` through `100`. `durationMs` and `snapshotLagMs` are milliseconds. Quota dates
are UTC calendar dates (`YYYY-MM-DD`) because free allowances reset at 00:00 UTC. The custom event
does not contain `requestQuotaUtilization`, `rowWriteQuotaUtilization`, or an active-duration
estimate: those would misleadingly apply account-wide allowances to one board. Item utilization
uses the 10,000-live-item board limit, while storage utilization uses the deliberately conservative
per-board storage ceiling from the specification.

`durableObjectRequestUnitsEstimate` is explicitly a per-board workload model based on the published
20:1 billing ratio for incoming WebSocket messages. It is not Cloudflare's account bill and may not
include every HTTP, alarm, RPC, or platform adjustment. Use the built-in account usage view or
Metrics and Analytics API for alert thresholds; use `quota.daily` only to explain which active
boards contributed modeled work. The runtime persists only R2 snapshot bytes written; it does not
invent an R2 bytes-read counter.

For the daily 70% alert, `account_request_utilization` is the larger of Cloudflare's UTC-day
account Worker-request and Durable Object billed-request utilization ratios.
`account_row_write_utilization` is Cloudflare's UTC-day account Durable Object SQLite rows written
divided by the applicable plan allowance. The evaluator must read the account's actual plan and
allowances; the repository does not hard-code a billing entitlement into a per-board event.

## Saved queries and charts

The saved-query request bodies use the `cloudflare-workers` dataset and scope every query to
services whose `$metadata.service` starts with `cloudflare-collab-canvas`. The account-level query
list is shared by account users, so use the `[Collab Canvas]` prefix and check for an existing name
before any POST; the create endpoint is not an idempotent upsert.

The dashboard should be summary-first:

1. Prominent health row: active sockets, command rejection mix, p95 commit handling, replay/resync,
   snapshot lag, handler internal-error outcomes, and Worker/DO CPU.
2. Capacity row: board item/storage utilization, per-board UTC-day workload estimates, and a
   separate Cloudflare-native account quota view.
3. Diagnostic row: preview/commit frames, broadcast fanout/failures, SQLite duration, R2 snapshot
   outcomes, and undo/redo conflict mix.

The `chart` object beside each saved request declares its visualization, units, selected aliases,
and splits. It is not sent to the Cloudflare save-query endpoint. Reproduce that layout in Query
Builder or the chosen external dashboard after the query has real data.

The built-in CPU chart filters to `$metadata.type = "cf-worker-event"` and groups by
`$workers.executionModel` plus `$workers.entrypoint`. This keeps stateless gateway CPU separate
from `BoardRoom` Durable Object CPU, while p95 wall time remains available to identify I/O wait.
CPU time is active processing time; wall time includes waiting on storage and other I/O.
Neither value is presented as billed Durable Object active duration.

## Reviewed remote setup

No repository command performs these operations. When an operator has explicitly approved remote
changes:

1. Create a short-lived account-scoped token with `Workers Observability Write`. Keep it separate
   from the deployment token and never put it in Worker variables or secrets.
2. Use `POST /accounts/{account_id}/workers/observability/telemetry/keys` and the values endpoint to
   verify deployed field keys, types, service names, event names, and result codes.
3. List existing account queries with
   `GET /accounts/{account_id}/workers/observability/queries?orderBy=updated&order=desc`. Compare the
   exact `[Collab Canvas]` names and parameters; do not create duplicates.
4. Review `npm run --silent observability:plan`. Submit only each plan entry's `body` to the saved-query
   endpoint using an approved API client, or recreate it in Query Builder. Record returned query
   IDs outside the repository configuration.
5. Run every saved query over a narrow staging window. Confirm non-empty series, units, splits,
   cardinality, and privacy before reproducing the chart layout.
6. Independently verify that the account's Cloudflare Metrics and Analytics surface exposes the
   Worker request, Durable Object request/duration, and SQLite row counters needed by the quota
   evaluator. Do not derive those account totals from custom log events.
7. Revoke the one-time token unless an alert evaluator legitimately needs to run stored telemetry
   queries. A read-only list permission is not enough to create a query; telemetry query execution
   currently requires `Workers Observability Write`.

Official references:

- [Workers Observability Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
- [Save a Workers Observability query](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/queries/methods/create/)
- [Run a temporary or saved telemetry query](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
- [Workers Logs structured JSON guidance](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Worker metrics and invocation status](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Durable Object observability](https://developers.cloudflare.com/durable-objects/observability/)

## Alert evaluation and delivery prerequisites

The seven declarative conditions are intentionally not represented as provisioned alerts. Before
enabling notifications, provide an evaluator that runs at least once per minute, supplies an
explicit telemetry timeframe, computes grouped ratios from the saved-query results and the
Cloudflare-native account usage source, applies `holdFor`, deduplicates open incidents, records its
last successful run, and alerts independently when evaluation becomes stale.

| Alert | Exact trigger from section 20.3 | Default evaluation contract |
| --- | --- | --- |
| Rejected commands | Rejected / all commands exceeds 5% for five minutes | 5-minute window; condition held for 5 minutes |
| Internal errors | `internalError=true` / all handler completions exceeds 1% | 5-minute window |
| Snapshot lag | Any board exceeds 1,000 actions **or** 30 minutes | Maximum per privacy-safe board hash |
| Board limit | Any board exceeds 80% of item **or** storage limit | Maximum utilization per board |
| Daily quota | Free-plan request **or** row-write estimate exceeds 70% | UTC-day Cloudflare-native account usage; `quota.daily` is drilldown only |
| Replay resync | Resync-required replay outcomes exceed 2% of accepted connections | 15-minute ratio |
| Commit handling | p95 accepted command handling exceeds 25 ms | 5-minute p95 by action kind |

Configure and test at least one owned delivery destination. Email requires a monitored account
address. PagerDuty requires a connected service and escalation policy. Webhooks require a
credentialed HTTPS receiver that validates test payloads, responds promptly, and handles retries
idempotently. PagerDuty and webhook availability varies by the account's zone plans, so check
eligibility before selecting them. If Cloudflare Notifications manages the destination or policy,
the setup credential additionally needs `Notifications Write`; an external evaluator delivering
directly uses that system's permissions instead.

Workers Observability saved queries are not arbitrary Cloudflare Notification alert types. Do not
create a generic Notification policy and assume it evaluates these seven conditions. A delivery
test must prove the complete path from an intentionally triggered staging condition through the
evaluator to acknowledgement by the on-call destination.

## Triage

- Rejection alert: split by stable `code` first. Validation, authorization, rate limiting, and
  resource/storage errors require different responses.
- Internal-error alert: compare `executionComponent`, `$workers.outcome`, and error logs. Separate
  a mapped application 5xx from an uncaught runtime outcome.
- Snapshot lag/R2 failure: inspect scheduled alarm state and `snapshot.failed`; SQLite remains the
  source of truth and ordinary board routing must not depend on R2.
- Board utilization: use only `boardIdHash` in telemetry. Follow the metadata-only inspection and
  `SQLITE_FULL` procedures in `docs/operations.md`.
- Quota alert: verify the UTC-day account totals in Cloudflare Metrics and Analytics, then use
  per-board `quota.daily` estimates for attribution. Disable new board creation before a hard limit
  while preserving existing read/reconnect/export paths.
- Replay alert: compare retention/compaction boundaries with client prior-sequence distribution.
- Commit latency: compare action kind, SQLite p95, broadcast fanout, and built-in `BoardRoom` CPU
  before changing limits or optimizing code.

After remediation, keep the incident open until two full evaluation windows are healthy. Record
the query timeframe, service/environment, privacy-safe board hash where applicable, evaluator
version, and whether Cloudflare sampling or ingestion delay affected confidence.
