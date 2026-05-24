# OAuth Custom Connector Example

Use this for OAuth-native clients that support remote MCP discovery.

```text
Name: SimpleFIN Finance
Remote MCP server URL: https://finance.example.com/mcp
OAuth Client ID: leave blank unless your client requires a static client
OAuth Client Secret: leave blank unless your client requires a static client
```

The Worker advertises OAuth discovery metadata and supports Dynamic Client
Registration. Complete OAuth as the GitHub login configured in
`GITHUB_ALLOWED_LOGIN`.
