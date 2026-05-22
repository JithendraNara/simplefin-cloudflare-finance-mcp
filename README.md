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
- Vectorize semantic transaction search
- Raw SimpleFIN diagnostics scoped to one account at a time

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

## License

MIT
