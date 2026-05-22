# Security Policy

This project handles financial data. Treat every deployment as sensitive.

## Supported Versions

This starter tracks the `main` branch. Pin your own deployment and review changes before deploying them to production.

## Reporting Vulnerabilities

Please open a private security advisory or contact the maintainer privately. Do not publish live tokens, SimpleFIN Access URLs, D1 exports, or raw financial records in public issues.

## Deployment Rules

- Store all secrets with `wrangler secret put`.
- Never commit `.env`, local MCP configs, SimpleFIN setup tokens, SimpleFIN Access URLs, bearer tokens, OAuth client secrets, or database exports.
- Rotate any credential that was pasted into chat, logs, public issues, or committed files.
- Keep read-only bearer tokens separate from admin tokens.
- Limit OAuth admin access with `GITHUB_ALLOWED_LOGIN`.
- Use `simplefin_data_coverage` and `/ready` before trusting cached finance data.
