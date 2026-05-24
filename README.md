# SimpleFIN Cloudflare Finance MCP

A deploy-your-own remote MCP server for SimpleFIN finance data.

It runs on Cloudflare Workers, syncs SimpleFIN into D1, adds optional Workers AI enrichment, indexes transactions with Vectorize, and exposes account-aware finance tools to Claude, Cursor, Codex, OpenClaw, Hermes, and other MCP clients.

This repository is a public starter. It contains no tokens, no financial data, no Cloudflare resource IDs, and no personal deployment history.

## What You Get

- Remote MCP endpoint at `/mcp`
- OAuth for Claude and other OAuth-native MCP clients
- Bearer tokens for clients that support custom headers
- Scheduled SimpleFIN sync with a 3-day incremental overlap
- Automatic account-specific 90-day backfill for new/problem accounts
- D1 cache with normalized accounts, transactions, sync runs, coverage, and audit events
- Workers AI transaction categorization and weekly briefings
- Honest AI health counters: real AI enrichments, deterministic fallbacks, parse failures, quota fallbacks, and low-confidence rows
- Deterministic category guardrails for obvious payments, fees, subscriptions, dining, and one-off purchases
- Vectorize semantic transaction search
- Raw SimpleFIN diagnostics scoped to one account at a time
- Sanitized D1 audit timing for MCP/HTTP operations without storing prompts, tool args, finance payloads, or tokens

## Architecture

```text
MCP client
  -> https://your-finance-domain.example.com/mcp
    -> Cloudflare Worker
      -> SimpleFIN Bridge
      -> D1 finance cache
      -> Workers AI
      -> Vectorize
```

## Quick Start

Install dependencies:

```bash
npm install
```

Create Cloudflare resources:

```bash
npx wrangler d1 create simplefin-finance --config worker/wrangler.toml
npx wrangler kv namespace create OAUTH_KV --config worker/wrangler.toml
npx wrangler vectorize create simplefin-transactions --dimensions=1024 --metric=cosine
```

Copy the returned D1 database ID and KV namespace ID into [worker/wrangler.toml](worker/wrangler.toml).

Set public deployment vars in [worker/wrangler.toml](worker/wrangler.toml):

```toml
GITHUB_ALLOWED_LOGIN = "your-github-login"
PUBLIC_ORIGIN = "https://finance.example.com"
PUBLIC_MCP_URL = "https://finance.example.com/mcp"
```

Apply migrations:

```bash
npx wrangler d1 migrations apply simplefin-finance --remote --config worker/wrangler.toml
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
npm run worker:typecheck
npx wrangler deploy --config worker/wrangler.toml
```

## SimpleFIN Setup

SimpleFIN setup tokens are one-time claim tokens. Claim them locally or with the admin MCP tool, then store only the resulting Access URL as a Cloudflare secret:

```bash
npx wrangler secret put SIMPLEFIN_ACCESS_URL --config worker/wrangler.toml
```

Never commit or paste:

- `SIMPLEFIN_ACCESS_URL`
- `MCP_BEARER_TOKEN`
- `ADMIN_TOKEN`
- GitHub OAuth client secret

## Auth Layers

There are two auth layers:

- SimpleFIN Bridge auth is not OAuth. It is a one-time setup-token claim that
  produces an Access URL.
- MCP client auth is OAuth or bearer-token auth to your Worker at `/mcp`.

Once `SIMPLEFIN_ACCESS_URL` is configured as a Worker secret, normal agents do
not need SimpleFIN setup tokens. They should connect to your deployed Worker.

## OAuth Setup

Create a GitHub OAuth app:

```text
Homepage URL: https://finance.example.com
Authorization callback URL: https://finance.example.com/callback
```

Set `GITHUB_ALLOWED_LOGIN` to the one GitHub login allowed to administer the MCP server.

Claude custom connector:

```text
Name: SimpleFIN Finance
Remote MCP server URL: https://finance.example.com/mcp
OAuth Client ID: leave blank
OAuth Client Secret: leave blank
```

## Bearer Client Config

Use this for clients that support Streamable HTTP plus headers:

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

Use `MCP_BEARER_TOKEN` for read-only tools. Use `ADMIN_TOKEN` only for setup, sync, and refresh operations.

Cloudflare Worker secrets are write-only in normal operation. Wrangler can set
or rotate `MCP_BEARER_TOKEN`, but it cannot reveal the existing plaintext token
later.

For remote agents on other machines:

- Use MCP OAuth if the client supports it.
- Otherwise transfer the read-only bearer token out-of-band through a password
  manager, SSH, or another private channel.
- Do not paste tokens into public chats, issues, logs, or committed config
  files.
- If the token is lost or exposed, rotate it with:

```bash
npx wrangler secret put MCP_BEARER_TOKEN --config worker/wrangler.toml
```

Then update every bearer-token client. OAuth clients do not need the bearer
token.

## MCP Tools

Read tools:

- `agent_guidance`
- `auth_context`
- `connection_status`
- `worker_operational_status`
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
- `find_unusual_transactions`
- `generate_weekly_money_briefing`

Admin tools:

- `sync_simplefin`
- `claim_setup_token`
- `categorize_uncategorized_transactions`
- `refresh_insights`

## Agent Workflow

For finance analysis, call:

1. `agent_guidance`
2. `auth_context`
3. `worker_operational_status`
4. `simplefin_data_coverage`
5. `finance_overview`

If coverage is unhealthy, call `simplefin_account_gaps` before making conclusions. Use `simplefin_raw_account` only with a specific `accountId` and a narrow `limit`.

Also check `worker_operational_status.health.issues[]` and
`worker_operational_status.ai_enrichment` before trusting AI-derived categories,
subscriptions, anomalies, or briefings. `enriched_transactions` only means a row
exists in `transaction_enrichment`; use `ai_enriched`, `fallback_enriched`,
`parse_fallback`, and `quota_fallback` to know whether Workers AI actually
succeeded.

The Worker intentionally uses Workers AI as an enrichment layer, not as the
source of truth. Structured JSON model output is repaired/validated, then
high-confidence deterministic guardrails correct obvious cases such as card
payments, returned payment fees, interest charges, Apple Store purchases,
DoorDash/Uber Eats/Grubhub dining, known subscriptions, and irregular merchants
that should remain reviewable.

Weekly briefings receive compact current-period totals, prior-period totals,
trailing-30-day fee totals, subscriptions, unusual transactions, and
human-safe `health.issues[]` messages. Agent-only `actionable_hint` values stay
in status tools so briefings stay focused on named merchants, amounts, coverage
issues, and concrete next actions.

Transaction enrichment stores `merchant_normalized` in lowercase so per-row
responses and SQL grouping remain stable. When SimpleFIN provides a payee, that
payee is preferred over model-generated merchant text to avoid spelling/case
drift. User-facing aggregate displays may canonicalize or title-case merchant
names separately.

## Smoke Tests

```bash
curl https://finance.example.com/health
curl https://finance.example.com/ready
```

MCP call:

```bash
curl -sS https://finance.example.com/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"simplefin_data_coverage","arguments":{}}}'
```

Admin sync:

```bash
curl -sS https://finance.example.com/admin/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"pending":true,"force":true}'
```

## Public Repo Safety

This repo is intentionally generic:

- placeholder Cloudflare IDs
- placeholder domain
- placeholder GitHub login
- no D1 export
- no `.env`
- no local bearer config
- no deployment-specific history

Before publishing your own fork, run:

```bash
rg -n "SIMPLEFIN_ACCESS_URL|ADMIN_TOKEN|MCP_BEARER_TOKEN|client_secret|finance\\.example\\.com|your-github-login"
git status --short
```

Seeing placeholder names in docs/config is fine. Seeing real token values is not.

If you keep a private fork for your own deployment, put real domains, Cloudflare
resource IDs, operational history, and agent handoff details there. Keep this
public starter free of personal endpoint names, real account IDs, D1 exports,
sync outputs, bearer tokens, OAuth secrets, or financial examples from a live
account.

## License

MIT
