# Finance Agent Workflow

Use this document as the operating guide for agents connected to a deployed SimpleFIN Finance MCP server.

## Auth Layers

Do not confuse SimpleFIN auth with MCP auth:

- SimpleFIN Bridge does not use OAuth. It uses a one-time setup token that is
  claimed into a secret Access URL.
- This Worker exposes OAuth/bearer auth for MCP clients at `/mcp`.
- Once `SIMPLEFIN_ACCESS_URL` is stored as a Worker secret, agents should
  connect to the Worker instead of asking the user for a new setup token.

## First Calls

1. `agent_guidance`
2. `auth_context`
3. `worker_operational_status`
4. `connection_status`
5. `simplefin_data_coverage`
6. `finance_overview`

Do not begin finance analysis if `/ready`, `worker_operational_status`, or `simplefin_data_coverage` reports stale or incomplete data.

## Coverage First

`simplefin_data_coverage` is the per-account trust gate. It reports:

- tracked account count
- untracked account count
- coverage status per account
- balance dates
- earliest/latest cached transaction dates
- backfill status
- SimpleFIN warning mappings

If coverage is unhealthy, call `simplefin_account_gaps` and explain the gap before answering money questions.

## Sync Behavior

Default sync is incremental and uses a 3-day overlap. This catches pending transaction settlement without repeatedly fetching the full history.

When a new or balance-only account appears, the Worker runs one account-specific 90-day backfill with the SimpleFIN `account=<id>` filter. It does not run a full 90-day all-account backfill during normal cron.

Only admins should call `sync_simplefin`.

## Context Budgeting

Prefer compact tools first:

- `finance_overview`
- `summarize_cashflow`
- `search_transactions`
- `semantic_transaction_search`

Avoid loading raw transaction history unless the user asks a narrow question. If raw SimpleFIN fields are needed, use `simplefin_raw_account` with one `accountId` and a limit.

## Read-Only Tools

- `agent_guidance`
- `auth_context`
- `worker_operational_status`
- `connection_status`
- `finance_overview`
- `list_accounts`
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

## Admin Tools

- `sync_simplefin`
- `claim_setup_token`
- `categorize_uncategorized_transactions`
- `refresh_insights`

Admin tools require either `ADMIN_TOKEN` or OAuth for the allowed GitHub login configured in `GITHUB_ALLOWED_LOGIN`.

## MCP Client Examples

Bearer-header clients:

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

Claude custom connector:

```text
Name: SimpleFIN Finance
Remote MCP server URL: https://finance.example.com/mcp
OAuth Client ID: leave blank
OAuth Client Secret: leave blank
```

## Safety

Never paste or expose:

- SimpleFIN setup token
- SimpleFIN Access URL
- bearer tokens
- OAuth client secret
- D1 database exports
- raw financial records in public logs, issues, or discussions
