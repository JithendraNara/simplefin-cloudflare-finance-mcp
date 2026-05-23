# SimpleFIN Finance MCP Worker

Cloudflare Worker that syncs SimpleFIN on a schedule into D1, enriches finance data with Workers AI, indexes transactions in Vectorize, and exposes a remote MCP server at `/mcp`.

This is the hosted agent layer. It does not need Docker.

## Architecture

```text
MCP-capable agent
  -> /mcp
    -> Cloudflare Worker
      -> D1 finance cache
      -> Workers AI enrichment
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
- `categorize_uncategorized_transactions`
- `find_unusual_transactions`
- `generate_weekly_money_briefing`
- `refresh_insights`
- `worker_audit_events` (admin only)

## Secure Operational Audit

Workers Logs are disabled in `wrangler.toml` because Cloudflare invocation
metadata can include request authorization headers. Operational audit events
are instead written to D1 table `operational_events` with 30-day retention.

The audit stores only known endpoint paths, MCP tool names, auth mode, admin
flag, status, duration, and limited scheduled-sync counts or error codes. It
does not store credentials, request bodies, tool arguments, or finance response
payloads. Read it with admin MCP tool `worker_audit_events` or
`GET /admin/debug/events`.

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
