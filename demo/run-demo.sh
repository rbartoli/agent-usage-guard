#!/usr/bin/env bash
# Launches the real interactive Claude Code UI in a disposable copy of the
# fictional Northstar API fixture, with this repository loaded as the only
# plugin. Nothing is rendered or replayed: the recording captures Claude Code's
# own interface. Your settings, plugins, MCP servers and sessions stay out.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
model="${AGENT_GUARD_DEMO_MODEL:-haiku}"
command -v claude >/dev/null || { echo "Claude Code is required but was not found on PATH." >&2; exit 1; }

workdir="$(mktemp -d "${TMPDIR:-/tmp}/agent-usage-guard-demo-XXXXXX")"
trap 'rm -rf "$workdir"' EXIT
cp -R "$root/demo/fixture/northstar-api/." "$workdir/"
cd "$workdir"

# The audit needs Agent and Read, pre-approved so the only dialog on screen is
# the guard's question; AskUserQuestion is the dialog the guard asks in. The
# native caps are set loose so the guard is the binding limit.
CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20 \
CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 \
claude \
  --plugin-dir "$root" \
  --setting-sources project \
  --strict-mcp-config --mcp-config "$root/demo/empty-mcp.json" \
  --tools Agent,Read,AskUserQuestion \
  --allowedTools Agent Read \
  --model "$model" \
  --effort low \
  --permission-mode default \
  --exclude-dynamic-system-prompt-sections \
  --name agent-usage-guard-demo
