#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-cloudflare/cloudflared-config.example.yml}"

exec cloudflared tunnel --config "$CONFIG_PATH" run
