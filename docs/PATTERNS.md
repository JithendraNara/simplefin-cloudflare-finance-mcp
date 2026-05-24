# Reusable MCP Patterns

This project is a finance MCP starter, but several patterns are reusable for
other agent-facing MCP servers.

## Honest AI Health Counters

Do not report only `enriched: N/N`. That hides whether the model actually
worked.

Expose separate counters:

```json
{
  "transactions": 128,
  "ai_enriched": 126,
  "fallback_enriched": 2,
  "parse_fallback": 0,
  "quota_fallback": 0,
  "low_confidence_enriched": 9,
  "healthy": true
}
```

This lets an agent decide whether categories, subscriptions, anomalies, and
briefings are trustworthy before using them in a financial answer.

## Provenance Flags For AI Or Fallback Output

When a tool can use either LLM reasoning or a deterministic baseline, return the
source explicitly.

```json
{
  "explanation_status": "ai",
  "unusual_transactions": [
    {
      "merchant": "Demo Electronics",
      "amount": 499,
      "reason": "Large one-off purchase above merchant baseline."
    }
  ]
}
```

If the model fails, return `explanation_status: "deterministic"` and a short
fallback note instead of silently blending both paths.

## Structured Stats Instead Of Binary Labels

Avoid returning only `is_subscription: true`. Give the downstream agent the
evidence:

```json
{
  "merchant": "Demo Streaming",
  "average_amount": 19.99,
  "coefficient_of_variation": 0,
  "interval_average_days": 30,
  "interval_stddev_days": 1.2,
  "score": 0.94,
  "explicit_subscription_signal": true
}
```

Structured stats let agents explain uncertainty, rank candidates, and avoid
overconfident conclusions.

## Coverage Before Conclusions

Finance data is easy to over-trust. A remote MCP should expose data coverage as
a first-class concept:

- last successful sync
- scheduled sync verification
- account count changes
- per-account balance dates
- earliest/latest transaction dates
- source-system warnings
- backfill status

The `simplefin_data_coverage` and `worker_operational_status.health.issues[]`
tools exist so agents can say, "I can answer this," or "the cache is stale,"
before doing analysis.

## Agent Guidance As A Tool

Documentation is useful, but agents do not always read the repo. Give them a
first-call tool that returns:

- recommended call order
- trust gates
- context budgeting hints
- admin/read-only distinction
- warnings about raw data tools

That makes the MCP self-documenting at runtime.
