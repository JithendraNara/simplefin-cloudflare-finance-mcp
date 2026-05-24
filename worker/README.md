# SimpleFIN Finance MCP Worker

Cloudflare Worker that syncs SimpleFIN on a schedule into D1, enriches finance
data with Workers AI plus optional Cloudflare AI Gateway routing, indexes
transactions in Vectorize, and exposes a remote MCP server at `/mcp`.

This is the hosted agent layer. It does not need Docker.

## Architecture

```text
MCP-capable agent
  -> /mcp
    -> Cloudflare Worker
      -> D1 finance cache
      -> Workers AI hot-path enrichment
      -> optional AI Gateway reasoning provider
      -> Vectorize semantic search
      -> scheduled SimpleFIN sync
```

## Setup

Create D1:

```bash
npx wrangler d1 create simplefin-finance --config worker/wrangler.toml
```

Copy the returned database UUID into `worker/wrangler.toml`.

Apply migrations:

```bash
npx wrangler d1 migrations apply simplefin-finance --remote --config worker/wrangler.toml
```

Create Vectorize:

```bash
npx wrangler vectorize create simplefin-transactions --dimensions=1024 --metric=cosine
```

Create OAuth KV:

```bash
npx wrangler kv namespace create OAUTH_KV --config worker/wrangler.toml
```

Set secrets:

```bash
npx wrangler secret put SIMPLEFIN_ACCESS_URL --config worker/wrangler.toml
npx wrangler secret put MCP_BEARER_TOKEN --config worker/wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml
npx wrangler secret put GITHUB_CLIENT_ID --config worker/wrangler.toml
npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.toml
openssl rand -base64 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY --config worker/wrangler.toml
npx wrangler secret put AI_GATEWAY_TOKEN --config worker/wrangler.toml
```

Deploy:

```bash
npx wrangler deploy --config worker/wrangler.toml
```

Optional custom domain after deploy:

```bash
npx wrangler triggers deploy --config worker/wrangler.toml
```

Then configure `finance.example.com` in Cloudflare Workers Routes or Custom Domains.

## Test Scheduled Sync Locally

```bash
npx wrangler dev --config worker/wrangler.toml --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

## MCP Auth

The canonical remote MCP URL is:

```text
https://finance.example.com/mcp
```

Claude.ai, Claude Code, Cursor, and future OAuth-native clients should use OAuth.
Create a GitHub OAuth app with:

```text
Homepage URL: https://finance.example.com
Authorization callback URL: https://finance.example.com/callback
```

Only GitHub login `your-github-login` is allowed, and OAuth sessions receive admin
MCP access. Bearer tokens remain supported for clients that can only send
headers. Read-only sessions see only read tools; admin and OAuth sessions also
see setup, sync, categorization, and refresh tools.

Dynamic client registrations are preflighted before they reach the OAuth
provider. HTTPS redirect URIs are allowed, with loopback HTTP reserved for local
development clients. Only authorization-code/refresh-token flows are accepted.

## Bearer MCP Client Config

```json
{
  "mcpServers": {
    "simplefin": {
      "type": "streamable-http",
      "url": "https://finance.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_BEARER_TOKEN>"
      }
    }
  }
}
```

Use `ADMIN_TOKEN` instead of `MCP_BEARER_TOKEN` only for administrative tools such as `sync_simplefin`, `claim_setup_token`, `categorize_uncategorized_transactions`, and `refresh_insights`.

## Debug API

`/health` and `/ready` are public status endpoints. Administrative endpoints
require:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Endpoints:

- `GET /health`
- `GET /ready`
- `POST /admin/sync`
- `GET /admin/debug/accounts`
- `GET /admin/debug/transactions?limit=200`
- `GET /admin/debug/events?limit=50`
- `GET /admin/oauth/grants?user_id=<provider-user-id>`
- `POST /admin/oauth/revoke`

Without explicit `startDate` or `days`, sync is incremental: after the initial
backfill it starts from the last successful sync end date with a small
`INCREMENTAL_OVERLAP_DAYS` overlap so pending transactions can settle without
re-fetching the full history.

If a new financial account is connected, the next scheduled or manual
incremental sync automatically runs one account-specific 90-day backfill using
the SimpleFIN `account=<id>` filter. Scheduled syncs do not re-fetch the
previous 90 days for every account.

`/ready` returns `503` when the latest successful sync is older than
`DATA_MAX_STALENESS_HOURS`, the cache has no transactions, or account coverage
has unresolved backfill gaps. Agent-facing tools also include `data_freshness`
and `account_coverage` so clients do not silently trust stale or partial cached
finance data.

`worker_operational_status` and `/ready` also include `scheduled_sync`. A cron
configuration is not considered runtime-verified until
`scheduled_sync.verification_status` becomes `verified` after a completed
scheduled sync.

`worker_operational_status` is the main operational trust gate. It includes
`health.issues[]` plus an `ai_enrichment` block that separates successful AI
rows from deterministic fallback rows:

- `ai_enriched`
- `fallback_enriched`
- `parse_fallback`
- `quota_fallback`
- `low_confidence_enriched`

Do not rely on `enriched_transactions` alone. It only means an enrichment row
exists. A healthy cache should have low or zero fallback, parse, and quota
counts.

Example:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://finance.example.com/admin/debug/accounts"
```

## MCP Tools

- `agent_guidance`
- `connection_status`
- `auth_context`
- `worker_operational_status`
- `sync_simplefin`
- `claim_setup_token`
- `list_accounts`
- `finance_overview`
- `simplefin_data_coverage`
- `simplefin_account_gaps`
- `simplefin_raw_account`
- `simplefin_sync_history`
- `get_transactions`
- `search_transactions`
- `semantic_transaction_search`
- `summarize_cashflow`
- `detect_subscriptions`
- `detect_recurring_obligations`
- `merchant_summary`
- `query_finance`
- `categorize_uncategorized_transactions`
- `correct_transaction` (admin only)
- `recategorize_low_confidence` (admin only)
- `undo_correction` (admin only)
- `label_eval_transaction` (admin only)
- `run_eval` (admin only)
- `list_corrections`
- `get_eval_history`
- `find_unusual_transactions`
- `generate_weekly_money_briefing`
- `refresh_insights`
- `worker_audit_events` (admin only)

Weekly briefing generation requests structured JSON from the configured AI
reasoning provider and retries once when the model returns invalid JSON. If
both attempts fail, the Worker
saves and returns a deterministic aggregate fallback instead of failing sync.
Briefings receive current-period totals, prior-period totals, an explicit
comparison window, trailing-30-day fee totals, top subscriptions, unusual
transactions, and human-safe `health.issues[]` messages so they can call out
named merchants, amounts, date windows, data coverage issues, and concrete
actions without repeating agent-only `actionable_hint` instructions.

Transaction categorization uses structured Workers AI output plus deterministic
guardrails for obvious card payments, returned payment fees, interest charges,
known subscriptions, dining delivery, transport, and irregular merchants that
should remain reviewable.
The stored `merchant_normalized` value is lowercase by design. The canonicalizer
strips common processor/code suffixes and maps common synonyms such as
`interest` to `interest charge`. Display layers can canonicalize names
separately.

The categorizer recognizes taxonomy extensions for hard finance cases:
`rewards`, `cash_advance`, `debt_collection`, and `business`. BNPL/installments
remain in the underlying spend category while recurring-obligation tools track
the obligation pattern.

`worker_operational_status.ai_enrichment` includes `low_confidence_threshold`,
its derivation, and a `confidence_distribution` histogram. When holdout
calibration exists, the threshold comes from the lowest holdout confidence band
with precision at or above 0.85; otherwise it falls back to the default.

`merchant_summary` provides merchant-specific totals, trend, account/category
distribution, weekday pattern, outliers, and recent rows. Use it before loading
large raw transaction windows.

`detect_recurring_obligations` extends `detect_subscriptions` with recurring
fees and other obligation-like spend such as BNPL/installments.

Learning feedback is D1-backed. `correct_transaction` records before/after
values in `user_corrections`, refreshes the corrected transaction's Vectorize
embedding, and feeds recent corrections into future categorization prompts.
Holdout eval rows are protected: `correct_transaction` and `undo_correction`
refuse transactions labeled with `split: "holdout"`.

`label_eval_transaction` accepts `split: "train" | "holdout" |
"rolling_holdout"`. `run_eval` reports per-split metrics, so train metrics can
catch regressions against taught examples while holdout/rolling-holdout metrics
carry quality claims.

## AI Routing

Per-task routing lets you use a fast, reliable model for classification and a
larger reasoning model only where it pays off:

- `categorize_transactions`: Workers AI plus deterministic guardrails,
  corrections, and merchant canonicalization.
- `semantic_index_transaction` / `semantic_reindex_transaction`: Workers AI
  embeddings through `EMBEDDING_MODEL`.
- `generate_weekly_money_briefing`: optional Gateway-backed
  model.
- `find_unusual_transactions`: deterministic anomaly selection plus optional
  Gateway-backed explanation generation.
- `query_finance`: optional Gateway-backed natural-language synthesis over
  compact summaries and narrow transaction matches.
- `recategorize_low_confidence`: optional Gateway-backed review for rows below
  the confidence threshold. Writeback is gated by
  `ENABLE_GATEWAY_CATEGORIZER_FALLBACK=true`.
- `generate_correction_rule_text`: optional Gateway-backed reusable rule text
  for corrections.
- `review_uncategorized_suggestions`: reserved latency-tolerant reasoning route.

Set route vars in `worker/wrangler.toml` and keep real Gateway credentials in
the `AI_GATEWAY_TOKEN` secret:

```toml
AI_TEXT_PROVIDER = "workers_ai"
AI_ROUTE_CATEGORIZE_TRANSACTIONS = "workers_ai"
AI_ROUTE_FIND_UNUSUAL_TRANSACTIONS = "gateway"
AI_ROUTE_GENERATE_WEEKLY_MONEY_BRIEFING = "gateway"
AI_ROUTE_QUERY_FINANCE = "gateway"
AI_ROUTE_REVIEW_UNCATEGORIZED_SUGGESTIONS = "gateway"
AI_ROUTE_RECATEGORIZE_LOW_CONFIDENCE = "gateway"
AI_ROUTE_GENERATE_CORRECTION_RULE_TEXT = "gateway"
AI_GATEWAY_ACCOUNT_ID = "00000000000000000000000000000000"
AI_GATEWAY_ID = "default"
AI_GATEWAY_PROVIDER = "custom-provider"
AI_GATEWAY_MODEL = "provider-model-name"
GATEWAY_TOTAL_PER_5HOURS = "500"
GATEWAY_LIMIT_GENERATE_WEEKLY_MONEY_BRIEFING = "20"
GATEWAY_LIMIT_FIND_UNUSUAL_TRANSACTIONS = "100"
GATEWAY_LIMIT_QUERY_FINANCE = "200"
GATEWAY_LIMIT_RECATEGORIZE_LOW_CONFIDENCE = "50"
GATEWAY_LIMIT_GENERATE_CORRECTION_RULE_TEXT = "100"
GATEWAY_LIMIT_REVIEW_UNCATEGORIZED_SUGGESTIONS = "100"
ENABLE_GATEWAY_CATEGORIZER_FALLBACK = "false"
```

Gateway-backed reasoning models may emit reasoning blocks before final JSON.
The Worker strips `<think>...</think>`, extracts balanced JSON candidates, and
applies JSON repair before falling back.

`worker_operational_status` exposes `ai_token_usage_today`,
provider-specific token counters such as `gateway_tokens_today`, and the
5-hour request limiter under `gateway_rate_limit`.

MiniMax-compatible custom providers work with this shape, but they are only one
example. Any OpenAI-compatible Cloudflare AI Gateway provider can fill the
reasoning route.

## Secure Operational Audit

Workers Logs are disabled in `wrangler.toml` because Cloudflare invocation
metadata can include request authorization headers. Operational audit events
are instead written to D1 table `operational_events` with 30-day retention.

The audit stores only known endpoint paths, MCP tool names, auth mode, admin
flag, status, duration, and limited scheduled-sync counts or error codes. It
does not store credentials, request bodies, tool arguments, or finance response
payloads. Read it with admin MCP tool `worker_audit_events` or
`GET /admin/debug/events`.

For streamed MCP responses, audit `duration_ms` is recorded when the response
body closes. Slow AI tools should show larger durations than cheap metadata
calls.

For OAuth token incident response, use the admin-only OAuth grant endpoints to
list grants for the provider user ID and revoke each affected grant. Revocation
invalidates its OAuth access and refresh tokens; the client must authenticate
again.

## Verification

```bash
npm run worker:typecheck
npx wrangler types /tmp/simplefin-worker-types.d.ts --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml --dry-run --outdir /tmp/simplefin-finance-mcp-dry-run
npx wrangler dev --config worker/wrangler.toml --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

Production smoke:

```bash
curl https://finance.example.com/health
curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST \
  "https://finance.example.com/admin/sync"
```

After sync, verify account-level coverage:

```bash
curl -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"simplefin_data_coverage","arguments":{}}}' \
  "https://finance.example.com/mcp"
```
