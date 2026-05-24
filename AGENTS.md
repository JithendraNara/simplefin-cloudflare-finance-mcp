# AGENTS.md

This repository is a public starter for a self-hosted SimpleFIN finance MCP server on Cloudflare Workers.

Start here:

1. Read [README.md](README.md).
2. Configure [worker/wrangler.toml](worker/wrangler.toml) with your own Cloudflare resource IDs, domain, and GitHub login.
3. Store real credentials only with `wrangler secret put`.
4. Deploy the Worker.
5. Connect agents to `https://your-domain.example.com/mcp`.
6. Call `agent_guidance`, `worker_operational_status`, and `simplefin_data_coverage` before finance analysis.

Security rules:

- Never commit SimpleFIN Access URLs, bearer tokens, OAuth client secrets, D1 exports, or real transaction data.
- Keep deployment-specific docs in your private fork or private notes.
- Public examples should use placeholders such as `finance.example.com`, `<MCP_BEARER_TOKEN>`, and `your-github-login`.
- Read-only bearer clients should not see admin tools.
- OAuth admin access is limited by `GITHUB_ALLOWED_LOGIN`.
- Keep Workers Logs disabled for this Worker because invocation metadata can
  contain authorization headers. Use admin-only `worker_audit_events` for
  sanitized operational evidence.
- Remote agents cannot read Cloudflare Worker secret values later. Use MCP
  OAuth, or transfer the read-only bearer token out-of-band through a private
  channel. Do not tell agents to pull existing secret plaintext from Wrangler.

Agent usage rules:

- Do not call `sync_simplefin` before every question.
- Trust `/ready` only when both freshness and account coverage are healthy.
- Check `scheduled_sync.verification_status`; configured cron is not proven
  until a scheduled run has completed.
- Use `simplefin_data_coverage` as the account-level trust gate.
- Use `worker_operational_status.health.issues[]` as the global trust gate.
- Check `ai_enrichment.ai_enriched`, `fallback_enriched`, `parse_fallback`,
  and `quota_fallback` before trusting AI-derived categories, subscriptions,
  anomaly explanations, or briefings.
- Keep categorization on Workers AI plus deterministic rules/corrections unless
  your own eval proves another provider preserves merchant normalization,
  latency, and parse reliability. Use Gateway-backed models such as MiniMax for
  slower reasoning tasks like weekly briefings, anomaly explanations,
  `query_finance`, correction-rule generation, and low-confidence review
  suggestions.
- Request-capped Gateway providers still need local safety caps. Preserve the
  5-hour MiniMax limiter and expose `worker_operational_status.minimax_rate_limit`.
- `recategorize_low_confidence` should default to preview/non-writeback mode.
  Writeback requires `ENABLE_MINIMAX_CATEGORIZER_FALLBACK=true`.
- Gateway-backed reasoning models may emit `<think>...</think>` before JSON.
  Preserve the shared parser cleanup path and check
  `worker_operational_status.ai_token_usage_today` plus provider token counters
  when validating routing and budget.
- Status tools may include agent-only `actionable_hint` values. Briefing prompts
  should use human-safe issue messages so final prose does not repeat tool
  instructions.
- Store `merchant_normalized` lowercase for stable per-row results and grouping;
  strip common processor/code suffixes; map common synonyms such as `interest`
  to `interest charge`; display layers can canonicalize names separately.
- Use `merchant_summary` for merchant-specific questions instead of manually
  aggregating transaction search results.
- Use `detect_recurring_obligations` for monthly commitments beyond basic
  subscriptions, including recurring fees and BNPL/installment-like spend.
- Use `list_corrections` and `get_eval_history` when evaluating categorization
  quality. Admin agents can use `correct_transaction`,
  `label_eval_transaction`, and `run_eval` to create a measurable feedback
  loop.
- Corrections are stored in D1, feed future categorization prompts as
  few-shot examples, and refresh the affected transaction's Vectorize
  embedding.
- Suggested taxonomy: use `debt_collection` separately from `fees`; use
  `rewards` for card rewards/cashback; keep BNPL in the underlying spend
  category while recurring-obligation tools track the pattern; use
  `cash_advance` for Zolve/cash-advance-like rows; use `business` for cloud or
  infrastructure spend.
- Use `simplefin_raw_account` only for one `accountId` at a time with a narrow `limit`.
- Prefer summaries and search tools over loading all transactions into context.
- Keep [README.md](README.md) focused on positioning, sample output, and
  discovery. Put setup details in [docs/SETUP.md](docs/SETUP.md) and reusable
  design notes in [docs/PATTERNS.md](docs/PATTERNS.md).
- When modifying this public starter, keep examples generic. Real deployment
  domains, account names, transaction examples, D1 IDs, KV IDs, OAuth secrets,
  bearer tokens, and operational history belong only in a private fork.
