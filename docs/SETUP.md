# Setup

This guide configures a deploy-your-own SimpleFIN Finance MCP Worker. Keep real
domains, Cloudflare IDs, OAuth secrets, bearer tokens, and finance data out of
public forks.

## Install

```bash
npm install
```

## Create Cloudflare Resources

```bash
npx wrangler d1 create simplefin-finance --config worker/wrangler.toml
npx wrangler kv namespace create OAUTH_KV --config worker/wrangler.toml
npx wrangler vectorize create simplefin-transactions --dimensions=1024 --metric=cosine
```

Copy the returned D1 database ID and KV namespace ID into
[worker/wrangler.toml](../worker/wrangler.toml).

The default embedding model is `@cf/baai/bge-m3`, configured in
`EMBEDDING_MODEL`. If you choose a different model, create the Vectorize index
with that model's actual output dimensions.

## Configure Public Vars

Edit [worker/wrangler.toml](../worker/wrangler.toml):

```toml
GITHUB_ALLOWED_LOGIN = "your-github-login"
PUBLIC_ORIGIN = "https://finance.example.com"
PUBLIC_MCP_URL = "https://finance.example.com/mcp"
```

Optional custom domain:

```toml
[[routes]]
pattern = "finance.example.com"
custom_domain = true
```

## Apply Migrations

```bash
npx wrangler d1 migrations apply simplefin-finance --remote --config worker/wrangler.toml
```

## SimpleFIN Setup

SimpleFIN Bridge auth is not OAuth. It uses a one-time setup token that is
claimed into an Access URL. Store only the resulting Access URL as a Worker
secret:

```bash
npx wrangler secret put SIMPLEFIN_ACCESS_URL --config worker/wrangler.toml
```

Never commit or paste:

- `SIMPLEFIN_ACCESS_URL`
- `MCP_BEARER_TOKEN`
- `ADMIN_TOKEN`
- GitHub OAuth client secret
- D1 exports or raw financial records

Once `SIMPLEFIN_ACCESS_URL` is configured, normal agents connect to your Worker.
They do not need SimpleFIN setup tokens.

## Worker Auth Secrets

```bash
npx wrangler secret put MCP_BEARER_TOKEN --config worker/wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml
npx wrangler secret put GITHUB_CLIENT_ID --config worker/wrangler.toml
npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.toml
openssl rand -base64 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY --config worker/wrangler.toml
```

Cloudflare Worker secrets are write-only in normal operation. Wrangler can set
or rotate `MCP_BEARER_TOKEN`, but it cannot reveal the existing plaintext token
later.

## GitHub OAuth App

Create a GitHub OAuth app:

```text
Homepage URL: https://finance.example.com
Authorization callback URL: https://finance.example.com/callback
```

Set `GITHUB_ALLOWED_LOGIN` to the one GitHub login allowed to administer the MCP
server.

Claude, ChatGPT, Cursor, and other OAuth-capable remote MCP clients can use:

```text
Remote MCP server URL: https://finance.example.com/mcp
OAuth Client ID: leave blank unless the client requires a static client
OAuth Client Secret: leave blank unless the client requires a static client
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

Use `MCP_BEARER_TOKEN` for read-only tools. Use `ADMIN_TOKEN` only for setup,
sync, and refresh operations.

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

## Deploy

```bash
npm run worker:typecheck
npm run build
npx wrangler deploy --config worker/wrangler.toml
```

## Smoke Tests

```bash
curl https://finance.example.com/health
curl https://finance.example.com/ready
```

MCP read call:

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

## Safety Check Before Publishing

```bash
rg -n "SIMPLEFIN_ACCESS_URL|ADMIN_TOKEN|MCP_BEARER_TOKEN|client_secret|finance\\.example\\.com|your-github-login"
git status --short
```

Placeholder names in docs and config are expected. Real values are not.
