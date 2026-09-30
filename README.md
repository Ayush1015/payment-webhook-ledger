# Payment Webhook Ledger

A small, runnable backend for a common payments problem: providers retry webhooks, deliveries arrive out of order, and merchant records can disagree with provider events.

This project stores authenticated payment events once and compares their latest state with an independent merchant-side payments ledger. It is a learning and interview project, not a payment processor or a production deployment. It does not charge cards or connect to Visa's systems.

## What it does

- Verifies timestamped HMAC-SHA256 signatures against the **raw request bytes**.
- Rejects signatures more than five minutes old or in the future.
- Uses PostgreSQL unique constraints on both event IDs and idempotency keys. Exact retries return `200`; new events return `201`; identity reuse with changed bytes returns `409`.
- Records payment amounts as integer minor units, never floating-point money.
- Reconciles the latest event for each payment against independently stored expected state.
- Flags missing ledger entries, missing webhooks, and differences in amount, currency or status.
- Persists each reconciliation run and its findings in one transaction.
- Runs reconciliation periodically in a separate worker, or manually through an authenticated admin endpoint.
- Includes unit, SQL and HTTP tests, a signed demo, Docker Compose and GitHub Actions checks.

## Stack

Node.js 22+, TypeScript, Express 5, PostgreSQL 16, Zod and Vitest. Local SQL tests use PGlite (embedded PostgreSQL). Set `TEST_DATABASE_URL` to run the same tests against a PostgreSQL service. No cloud account is required.

## Run locally

Requirements: Node.js 22+, npm, Docker with Compose v2.

```sh
npm ci
cp .env.example .env
docker compose up --build -d
curl http://localhost:3000/health
```

The example credentials are for local development only. Compose binds the API and database to `127.0.0.1`, not a public interface. Replace the webhook secret and admin key before any deployment. `.env` is ignored by Git.

Compose starts PostgreSQL, applies the schema with a one-shot migration service, then starts the API and worker. Data survives restarts in the `postgres-data` volume.

```sh
# Send signed demo webhooks: matching payment, mismatched amount, exact retries.
node --env-file=.env --import tsx scripts/demo.ts

# Logs and shutdown
docker compose logs -f api worker
docker compose down

# Destructive local reset: deletes the demo database
docker compose down -v
```

The demo uses fake INR amounts, creates a new pair of payment records each run, waits for the reconciliation grace period and prints the persisted report. It should show `201` then `200` for each event and an `amount_minor` finding for the mismatched payment. Existing demo runs can add older findings to the report.

### Develop without containerizing Node

```sh
docker compose up -d db
node --env-file=.env --import tsx src/migrate.ts
node --env-file=.env --import tsx src/server.ts
# Separate terminal
node --env-file=.env --import tsx src/worker.ts
```

The `.env.example` database URL points to the host's local port; Compose uses its own `db` hostname internally. Run only one worker during development.

## API contract

### `POST /webhooks/payments`

Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `Idempotency-Key` | 1-128 letters, digits, underscores or hyphens |
| `X-Webhook-Signature` | `t=<unix_seconds>,v1=<lowercase_hex_hmac>` |

The HMAC input is `<unix_seconds>.<raw_body>`, signed with `WEBHOOK_SECRET`. See `src/signature.ts` and `scripts/demo.ts` for working signing code. This is a **custom demo protocol**, not Stripe's or another provider's webhook format.

```json
{
  "event_id": "evt_001",
  "payment_id": "pay_001",
  "amount_minor": 5000,
  "currency": "INR",
  "status": "captured",
  "occurred_at": "2026-09-01T12:00:00Z"
}
```

`status` is `captured`, `failed` or `refunded`. Currency is a three-letter uppercase code; the demo does not validate a currency registry. Unknown fields are rejected. Amounts must be non-negative safe integers in JavaScript. Request size is capped at 64 KiB. Event timestamps more than five minutes ahead are rejected.

| Status | Meaning |
| --- | --- |
| `201` | New event persisted |
| `200` | Identical retry already persisted |
| `400` | Invalid JSON, key or event |
| `401` | Missing, invalid or expired signature |
| `409` | Event ID/key reused with different content or identity |
| `413` | Request too large |
| `415` | Unsupported content type |
| `503` | Temporary service/database error; sender should retry |

A provider retry must preserve the key and exact body bytes, but may sign them with a fresh timestamp. Reformatting JSON is a changed request and returns `409`. The key is not part of the HMAC input; altered keys cannot insert an already-used event ID but can cause a conflict. This protocol assumes one trusted provider/secret. A multi-provider deployment needs provider-scoped identities and signatures.

### Admin and health

- `GET /health`: checks database connectivity; returns `200` or `503`.
- `POST /admin/reconcile`: requires `X-Admin-Key`, returns run ID, counts and findings.
- `GET /admin/runs/:id`: requires `X-Admin-Key`, returns the stored run and findings.

No public endpoint writes expected ledger state. In this demo, the seed script writes directly to `payments`; in a real system, that table should come from an independent merchant/order source.

## Architecture and correctness choices

```text
Provider / signed demo
        |
        v
Raw body -> HMAC + timestamp -> schema validation
        |
        v
webhook_events (unique event_id + idempotency_key)
        |
        +---------- latest event per payment --------+
                                                    |
Independent merchant state -> payments ------------+-> reconciliation worker
                                                         |
                                                         v
                                            runs + persisted findings
```

- **Durable idempotency:** inserts use `ON CONFLICT DO NOTHING`, then verify both identities and the body hash. PostgreSQL constraints, rather than an in-memory cache, decide which insert wins. A successful HTTP response follows a completed database write. This is retry-safe storage, not a claim of end-to-end exactly-once payment processing.
- **Out-of-order delivery:** latest state is selected by `occurred_at`, not receipt order. Equal timestamps use lexicographic event ID as a deterministic tie break. A real provider's monotonic sequence would be a better ordering guarantee.
- **Grace period:** recently changed payments or recently received/future-dated events are excluded as a whole payment until the cutoff, reducing transient false positives. This means an actively changing payment may remain deferred.
- **Snapshot:** each report uses a repeatable-read transaction, so comparisons and persisted findings belong to one consistent run. Historical webhook events remain immutable. The current expected ledger is not a versioned historical ledger.
- **Independent sources:** ingestion does not update `payments` from the webhook, which would make reconciliation self-confirming.
- **No automatic repair:** findings are flags for investigation. The job does not overwrite ledger values or issue refunds.
- **Worker:** it waits until a run finishes before scheduling the next one. Multiple worker processes or simultaneous manual runs can produce separate, valid reports; there is no distributed single-run lock.

## Tests and checks

```sh
npm run check
npm run build
npm test
# Optional: use a disposable PostgreSQL database instead of embedded PostgreSQL
TEST_DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger npm test
```

Tests cover signature tampering and expiry, malformed input, authentication, payload limits, durable duplicate handling, identity conflicts, safe amounts, missing records, field mismatches, out-of-order events, ties, grace periods, empty reports and stored run retrieval. PostgreSQL-backed tests isolate each test in its own schema and roll it back. Use a disposable test database, not production.

The GitHub Actions workflow runs type checks, the build, tests on embedded PostgreSQL, tests on a PostgreSQL 16 service, and Compose configuration validation. The workflow is not proof of a deployment or a container smoke test.

## Layout

```text
src/             API, signature checks, ingestion, SQL adapter, worker
scripts/demo.ts  Fake independent ledger records + signed webhook sender
db/001_init.sql Initial schema (idempotent bootstrap, not a migration framework)
tests/           Unit, SQL and HTTP tests
.github/         CI workflow
```

## Limits and next steps

No real provider integration, production traffic, benchmark, external user study or live deployment is claimed. This is a simplified state ledger, not double-entry accounting. Partial refunds, currency exponents, authorization/capture transitions and chargebacks are not modeled.

Before production use: add TLS, secret rotation and key IDs, rate limiting, provider-scoped IDs, provider-specific signatures/ordering, migration tooling, pagination/retention, metrics/alerts, backoff policy, admin access controls, audit trails and a durable worker coordination strategy. The current reconciliation reads the eligible state into memory and inserts findings one at a time; it is designed for a small demo, not an unbounded dataset.
