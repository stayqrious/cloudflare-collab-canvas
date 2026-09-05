# Deterministic load harness

This harness drives the public HTTP and WebSocket contracts against a running
local or staging Worker. It does not import the Durable Object or bypass the
gateway.

The normal scenario creates a new private board, provisions five editors and
15 viewers through multi-use invitations, and opens 20 browser-native
WebSockets. The board owner uses a separate, isolated browser context for HTTP
administration and is not one of the 20 socket clients. Every participant has
an independent Chromium context and therefore an independent
`__Host-wb_session` cookie jar.

## Prerequisites

- Node.js and the repository dependencies installed.
- Playwright Chromium installed (`npx playwright install chromium`) if it is
  not already in the local/CI cache.
- A running development Worker or an explicitly selected staging deployment.
- Turnstile disabled on local development, or one fresh `board_create` token
  plus 20 fresh `invitation_claim` tokens for a target where it is enabled.

Start the local Worker in one terminal:

```sh
npm run dev
```

Run the short smoke scenario in another terminal:

```sh
npm run load:smoke
```

Smoke mode still creates all 20 participants and exercises replay, a live
editor-to-viewer downgrade, forged viewer rejection, presence, previews, sync
checks, an authoritative resync/reconnect probe, a named R2 snapshot, and hash
convergence. It uses 20 accepted actions over 10 seconds and one deterministic
reconnect.

## Full 10-minute scenario

The default is the specification's deterministic 10-minute workload: 300
accepted durable pencil actions, five initially active drawers, 15 viewers, 12
preview frames per active drawer per second, presence at 2 Hz, sync checks at
30-second intervals, and eight deterministic reconnect/replay events.

```sh
npm run load
```

The workload timeline is paced from a monotonic start time. The short smoke
mode accelerates the same event ordering; changing `--duration-seconds` allows
an accelerated staging run while the driver rejects a pace above 4.5 durable
commits per drawer per second. Preview frames carry coalesced pencil points for
the 75 ms sampling window and are emitted at the required sustained 12 Hz,
inside the server's 15 Hz limit.

Wrangler assigns every local browser context the same loopback address, while
the gateway deliberately permits only five invitation claims per source IP
before a slow refill. For local development only, the harness supplies a
different RFC 2544 benchmarking address in `CF-Connecting-IP` for each claim.
Cloudflare sets/overwrites this header at the deployed edge, so it cannot
bypass staging or production throttles. A single-machine staging run must
therefore pace claims at the configured gateway rate, use distributed source
addresses, or use an explicitly test-scoped rate-limit exemption.

For staging, remote targeting must be deliberate:

```sh
LOAD_BASE_URL=https://staging.example.test \
LOAD_REMOTE_HOSTNAME=staging.example.test \
LOAD_ALLOW_REMOTE=1 \
npm run load
```

`LOAD_REMOTE_HOSTNAME` is the only accepted remote target and requires both
HTTPS and explicit opt-in. When `APP_HOSTNAME` identifies production, that host
is categorically rejected even if it is also supplied as the load target. The
isolated staging Worker deliberately disables Turnstile so Playwright
automation needs no challenge tokens. It still uses its own Durable Object
namespace, R2 bucket, session key, and classroom integration key.

After its initial burst of five, a single-host staging run spaces invitation
claims by 12.25 seconds to honor the gateway's per-IP refill rate. This adds
about three minutes before the workload begins. A test-scoped gateway exemption
or genuinely distributed source addresses can set
`LOAD_REMOTE_CLAIM_INTERVAL_MS=0`; local mode already uses distinct benchmark
addresses and never adds this delay.

The 20-active-drawer stress variant is:

```sh
npm run load -- --stress
```

Preview loss is accepted in stress mode because 20 × 12 Hz intentionally
exceeds the board's 200 preview-frame/s budget. Rejected, lost, duplicated, or
reordered durable actions still fail the run.

## Forced Durable Object eviction

There is intentionally no public production endpoint that can evict a Durable
Object, and Cloudflare's `evictDurableObject` helper is available only inside
Workers integration tests. A black-box run can include the required forced
eviction through a test-environment control hook:

```sh
LOAD_EVICTION_URL=https://staging-control.example/evict-board-room \
LOAD_EVICTION_AUTHORIZATION='Bearer test-control-secret' \
LOAD_REQUIRE_EVICTION=1 \
LOAD_BASE_URL=https://staging.example.test \
LOAD_REMOTE_HOSTNAME=staging.example.test \
LOAD_ALLOW_REMOTE=1 \
npm run load
```

At 80% of accepted actions the harness sends one `POST` to the hook with:

```json
{ "boardId": "b_...", "expectedSeq": 240 }
```

The hook must return a successful response only after it has forced eviction
of that board's room. The harness then verifies all surviving or reconnected
sockets with protocol sync checks and final sequence/hash assertions. The
Authorization value is optional and is never printed. `--require-eviction`
makes absence of the hook a preflight failure; ordinary local smoke runs omit
it.

## Assertions

The run fails unless all of the following hold:

- all 20 sockets receive `server.ready` within 10 seconds;
- every accepted sender receives exactly one authoritative acknowledgement;
- each client applies every sequence from 1 through the final sequence, with
  no gap or duplicate;
- reconnecting clients receive contiguous replay and return to ready;
- the downgraded live editor receives `access.changed`, becomes a viewer, and
  gets `FORBIDDEN` for a forged durable commit without consuming a sequence;
- no unexpected command rejection, overload close, or protocol error occurs;
- an authoritative `server.resync_required`/4009 response is paired exactly
  with a successful reconnect from the client's current sequence before the
  run continues (the harness induces this path once after the workload);
- every initial drawer emits preview traffic and every participant emits
  presence and sync-check traffic;
- end-to-end WebSocket acknowledgement p95 is at or below 300 ms in the full
  run (smoke mode allows 1,000 ms because local Wrangler is a functional
  sanity target, not an edge-latency measurement);
- the index-aware SQLite row-write estimate stays at or below the configured
  ceiling (4,000 rows by default);
- the final named R2 snapshot SHA-256 equals the current canonical JSON export
  SHA-256, every authorized client's export SHA-256, and every client's locally
  reconstructed canonical snapshot SHA-256.

Correctness never depends on a fixed post-action sleep. The driver waits on
`server.action`, `server.rejected`, `access.changed`, `server.ready`, replay
sequences, and sync responses. Timers are used only to generate the requested
traffic rate and enforce bounded failure timeouts.

Periodic sync checks are placed at explicit sequence barriers: every currently
connected client first observes the checkpoint sequence, then sends its check.
Reconnects deliberately use an older cursor and exercise replay. If a sync
request becomes stale while crossing a live broadcast, the server intentionally
sends `server.resync_required` and closes 4009; the browser reconnects from its
current authoritative cursor. The harness induces that path once and asserts
the paired close, fresh `server.ready`, contiguous sequence, and final hash.

The WebSocket acknowledgement metric is end-to-end RTT. The protocol does not
expose Durable Object handler CPU time, so the specification's under-10-ms p95
handler objective must be checked from Workers observability for the same run;
it cannot be truthfully inferred from client RTT. The final JSON event labels
the reported metric as `end_to_end_websocket_rtt`.

The default 300-action storage model is 3,792 billed rows: 4 initialization,
8 invitation creation, 80 claims, 3,600 ordinary action writes, 2 membership
change, 24 first-dirty job/alarm writes, a conservative 2 threshold-move
writes, 66 automatic-checkpoint writes, and 6 named-snapshot writes. The model
counts index updates and `setAlarm()` writes as Cloudflare bills them. Time and
250-action checkpoint bounds are added conservatively, so an actual paced run
may use fewer rows, but never substitutes the old five-logical-row estimate.

## Configuration

CLI options take precedence over environment variables loaded from the root
`.env`. Secrets and raw invitation/recovery values are never printed.

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--base-url` | `LOAD_BASE_URL` | `http://localhost:8787` |
| `--allow-remote` | `LOAD_ALLOW_REMOTE` | false |
| `--ignore-https-errors` | `LOAD_IGNORE_HTTPS_ERRORS` | false |
| `--headful` | `LOAD_HEADFUL` | false |
| `--smoke` | `LOAD_SMOKE` | false |
| `--stress` | `LOAD_STRESS` | false |
| `--seed` | `LOAD_SEED` | `424242` |
| `--actions` | `LOAD_ACTIONS` | `300` (`20` in smoke) |
| `--duration-seconds` | `LOAD_DURATION_SECONDS` | `600` (`10` in smoke) |
| `--preview-hz` | `LOAD_PREVIEW_HZ` | `12` |
| `--presence-hz` | `LOAD_PRESENCE_HZ` | `2` |
| `--sync-seconds` | `LOAD_SYNC_SECONDS` | `30` (`2` in smoke) |
| `--reconnects` | `LOAD_RECONNECTS` | `8` (`1` in smoke) |
| `--connect-timeout-ms` | `LOAD_CONNECT_TIMEOUT_MS` | `15000` |
| `--command-timeout-ms` | `LOAD_COMMAND_TIMEOUT_MS` | `10000` |
| `--final-timeout-ms` | `LOAD_FINAL_TIMEOUT_MS` | `30000` |
| `--max-connect-ms` | `LOAD_MAX_CONNECT_MS` | `10000` |
| `--max-p95-ack-ms` | `LOAD_MAX_P95_ACK_MS` | `300` (`1000` in smoke) |
| `--max-estimated-row-writes` | `LOAD_MAX_ESTIMATED_ROW_WRITES` | `4000` |
| `--turnstile-token` | `LOAD_TURNSTILE_TOKEN` | unset |
| environment only | `LOAD_TURNSTILE_CLAIM_TOKENS` | unset |
| `--remote-claim-interval-ms` | `LOAD_REMOTE_CLAIM_INTERVAL_MS` | `12250` (remote only) |
| `--eviction-url` | `LOAD_EVICTION_URL` | unset |
| `--eviction-authorization` | `LOAD_EVICTION_AUTHORIZATION` | unset |
| `--require-eviction` | `LOAD_REQUIRE_EVICTION` | false |

Run `npm run load -- --help` for the compact command reference.
