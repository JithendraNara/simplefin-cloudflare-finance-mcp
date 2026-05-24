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
- Status tools may include agent-only `actionable_hint` values. Briefing prompts
  should use human-safe issue messages so final prose does not repeat tool
  instructions.
- Store `merchant_normalized` lowercase for stable per-row results and grouping;
  prefer the SimpleFIN payee over model-generated merchant text when present;
  display layers can canonicalize names separately.
- Use `simplefin_raw_account` only for one `accountId` at a time with a narrow `limit`.
- Prefer summaries and search tools over loading all transactions into context.
- When modifying this public starter, keep examples generic. Real deployment
  domains, account names, transaction examples, D1 IDs, KV IDs, OAuth secrets,
  bearer tokens, and operational history belong only in a private fork.
