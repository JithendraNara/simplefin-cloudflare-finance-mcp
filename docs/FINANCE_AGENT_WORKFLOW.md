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

`worker_operational_status.scheduled_sync.verification_status` distinguishes a
configured cron from a cron that has actually completed in production. Treat
`awaiting_first_scheduled_run` as unverified scheduling, even when data is
fresh from a manual sync.

`worker_operational_status.health.issues[]` is the global trust gate. Treat
`critical` issues as blockers for confident analysis. Warnings should be named
in the answer when they affect the conclusion. Issue sources include data
freshness, account coverage, SimpleFIN errlist mappings, AI enrichment fallback
or quota problems, and other operational warnings.

`worker_operational_status.ai_enrichment` separates:

- `ai_enriched`: rows enriched by successful Workers AI output
- `fallback_enriched`: rows filled by deterministic fallback after AI failure
- `parse_fallback`: rows affected by model JSON parse problems
- `quota_fallback`: rows affected by daily AI budget limits
- `low_confidence_enriched`: successful but weak AI classifications
- `low_confidence_threshold`: threshold for the low-confidence count; derived
  from holdout calibration when available, otherwise the default is used
- `confidence_distribution`: confidence histogram for drift detection

Do not treat `enriched_transactions == transactions` as proof that AI worked.
It only proves every transaction has an enrichment row.

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

## AI And Insight Provenance

Workers AI is the default enrichment layer for hot-path categorization and
embeddings. SQL totals, account coverage, sync status, and raw SimpleFIN
diagnostics remain deterministic.

The Worker also supports optional per-task routing through Cloudflare AI
Gateway. A larger BYOK model is best used for
latency-tolerant reasoning tasks such as weekly briefings, unusual-transaction
explanations, `query_finance`, correction-rule generation, and low-confidence
review suggestions. Keep the main categorizer on Workers AI plus deterministic
rules/corrections unless your own eval proves the alternate provider preserves
merchant normalization and parse reliability.

Request-capped providers still need safety caps against loops. Check
`worker_operational_status.gateway_rate_limit`; if a cap is hit, the route
falls back to Workers AI where possible.

Categorization uses structured JSON output, JSON repair/validation, and
deterministic guardrails. Guardrails correct obvious card payments, fees,
interest charges, known subscriptions, dining delivery, transport, and
review-needed irregular merchants. The `ai_reason` field should explain whether
the final category came directly from AI or from a guardrail repair.

`find_unusual_transactions` returns `explanation_status` so agents know whether
the explanation came from the configured AI reasoning provider or deterministic
fallback. It should exclude routine transfers and known recurring subscriptions.

`query_finance` is for multi-step natural-language questions over compact
summaries and narrow transaction matches. It should not replace deterministic
SQL tools when the caller already knows the exact aggregation needed.

`generate_weekly_money_briefing` is expected to use current-period totals,
prior-period totals, an explicit `comparison_window`, trailing-30-day fee
totals, top subscriptions, unusual transactions, and human-safe
`health.issues[]` messages. Agent-only `actionable_hint` values remain in status
tools and should not appear in human briefing prose. Briefings should name
specific merchants, amounts, date windows, and actions instead of generic
category advice.

`detect_recurring_obligations` broadens the subscription view into
subscriptions, recurring fees, and other obligation-like spend such as BNPL or
installments.

`merchant_summary` is the preferred tool for merchant-specific questions. It
returns spend, trend, account distribution, category distribution, weekday
pattern, outliers, and recent rows.

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
- `detect_recurring_obligations`
- `merchant_summary`
- `list_corrections`
- `get_eval_history`
- `find_unusual_transactions`
- `generate_weekly_money_briefing`

## Admin Tools

- `sync_simplefin`
- `claim_setup_token`
- `categorize_uncategorized_transactions`
- `correct_transaction`
- `undo_correction`
- `label_eval_transaction`
- `run_eval`
- `refresh_insights`
- `worker_audit_events`

Admin tools require either `ADMIN_TOKEN` or OAuth for the allowed GitHub login configured in `GITHUB_ALLOWED_LOGIN`.

Corrections and calibration form the learning loop. `correct_transaction`
updates a cached transaction's enrichment, records a before/after correction in
D1, supersedes older corrections for the same transaction field, refreshes the
transaction's Vectorize embedding, and feeds recent corrections into future
categorization prompts. `label_eval_transaction`, `run_eval`, and
`get_eval_history` let deployers measure category precision/recall,
subscription quality, merchant exact-match accuracy, and confidence
calibration over time.

Eval labels have `train`, `holdout`, and `rolling_holdout` splits. Quote
holdout or rolling-holdout metrics for quality claims. Treat train metrics as
regression diagnostics only, because train rows may be corrected and used as
future prompt signal. Corrections refuse transactions labeled as holdout.

Suggested taxonomy extensions:

- `debt_collection` is separate from routine `fees`.
- Card rewards and cashback use `rewards`, not `income`.
- BNPL/installments keep the underlying spend category and are tracked by
  recurring-obligation tools.
- Zolve/cash-advance-like transactions use `cash_advance`, not ordinary
  `transfers`.
- Cloud infrastructure or business software spend can use `business`.

## Operational Audit

Keep Cloudflare Workers Logs disabled for this finance Worker. Invocation log
metadata can retain request headers, including bearer or OAuth authorization
values.

Admin sessions can call `worker_audit_events` to inspect a D1-backed sanitized
audit trail retained for 30 days. It records only known operational routes, MCP
tool names, auth mode, admin flag, response status, duration, and limited
scheduled-sync counts or error codes. It never stores request bodies, tool
arguments, finance responses, or credentials.

For streamed MCP responses, audit `duration_ms` is measured when the response
body closes, not when the `Response` object is first created. Slow AI tools
should therefore show materially larger durations than cheap metadata calls.

For incident response, an admin bearer session can use
`GET /admin/oauth/grants?user_id=<provider-user-id>` and
`POST /admin/oauth/revoke` with `{ "userId": "...", "grantId": "..." }` to
invalidate issued OAuth sessions after suspected token exposure.

## Remote Agents

Agents running on another machine cannot retrieve existing Cloudflare Worker
secret values. Wrangler can set or rotate secrets, but it cannot print the
plaintext `MCP_BEARER_TOKEN` or `ADMIN_TOKEN` after they are stored.

Use one of these paths:

- MCP OAuth: configure only the `/mcp` URL and complete OAuth in the client.
- Bearer header: transfer the read-only bearer token out-of-band through a
  password manager, SSH, or another private channel.

Do not ask users to paste bearer tokens into public chat. Do not ask for a
SimpleFIN setup token unless the bank connection is being replaced.

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

Dynamic Client Registration is preflighted before requests reach the OAuth
provider:

- redirect URIs must be syntactically valid and cannot use dangerous
  browser-executable schemes such as `javascript:`, `data:`, or `file:`
- only `code` response type is allowed
- only `authorization_code` and `refresh_token` grants are allowed
- token endpoint auth method must be `none`, `client_secret_basic`, or
  `client_secret_post`

The registration response omits `registration_client_uri` for compatibility
with ChatGPT custom connectors. The OAuth provider still stores the registered
client in KV; the management URI is not required for normal authorization-code
login.

## Safety

Never paste or expose:

- SimpleFIN setup token
- SimpleFIN Access URL
- bearer tokens
- OAuth client secret
- D1 database exports
- raw financial records in public logs, issues, or discussions
