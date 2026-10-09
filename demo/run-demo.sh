#!/usr/bin/env bash
# Opens one scene of the README demo: the real interactive Claude Code UI with
# this repository loaded as its only plugin, in a session resumed from a staged
# history. Claude Code talks to demo/scripted-api.ts instead of Claude, so no
# account is needed and no usage is spent. Your settings, plugins, sessions and
# home directory stay out: everything lives in a temporary directory that is
# deleted on exit.
#
#   demo/run-demo.sh cold-cache|fan-out|heavy-context|agent-tokens
#
# Needs Claude Code (CLAUDE_BIN, default `claude`) and Node.js 22.18 or later.
set -euo pipefail

scene="${1:-}"
case "$scene" in
  cold-cache) history=('Map how session cookies flow through the auth code before we refactor it.' 'Which tests cover it?') ;;
  fan-out) history=('What does this release candidate change?' 'Which of those areas have tests?' 'Anything risky in the database change?') ;;
  heavy-context) history=('List every cookie attribute the code sets.' 'Where is CookieSettings constructed?' 'Is samesite set anywhere else?') ;;
  agent-tokens) history=('Summarise the security review so far.' 'Which of them are confirmed?' 'Is anything still unreviewed?') ;;
  *) echo "usage: $0 cold-cache|fan-out|heavy-context|agent-tokens" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$(command -v "${CLAUDE_BIN:-claude}")" || { echo "Claude Code is required but was not found." >&2; exit 1; }

run="$(mktemp -d "${TMPDIR:-/tmp}/agent-usage-guard-demo-XXXXXX")"
api=''
trap '[ -n "$api" ] && kill "$api" 2>/dev/null; rm -rf "$run"' EXIT
home="$run/home"
config="$home/.claude"
work="$home/northstar-api"
mkdir -p "$config" "$work"
cp -R "$root/demo/fixture/northstar-api/." "$work/"

node "$root/demo/scripted-api.ts" "$work" >"$run/port" &
api=$!
for _ in $(seq 50); do [ -s "$run/port" ] && break; sleep 0.1; done
[ -s "$run/port" ] || { echo "The scripted API did not start." >&2; exit 1; }

# A made-up key for the scripted API, pre-approved so Claude Code does not ask
# about it, plus the onboarding and folder-trust answers a fresh config lacks.
key=not-a-real-key-the-scripted-api-accepts-any
node -e '
  const [path, work, key] = process.argv.slice(1)
  const config = {
    hasCompletedOnboarding: true, theme: "dark", autoUpdates: false,
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [work]: { hasTrustDialogAccepted: true } },
  }
  require("fs").writeFileSync(path, JSON.stringify(config))
' "$config/.claude.json" "$work" "$key"
echo '{"spinnerTipsEnabled": false}' >"$config/settings.json"

# Claude Code starts from a clean environment, so neither your own settings
# (AGENT_GUARD_* included) nor a Claude Code session you run this from leak in.
# The native subagent cap is set loose so the guard is the binding limit.
claude=(env -i HOME="$home" PATH="$PATH" SHELL=/bin/bash TERM="${TERM:-xterm-256color}"
  COLORTERM="${COLORTERM:-truecolor}" LANG="${LANG:-C.UTF-8}" CLAUDE_CONFIG_DIR="$config"
  ANTHROPIC_BASE_URL="http://127.0.0.1:$(cat "$run/port")" ANTHROPIC_API_KEY="$key"
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20
  "$bin" --plugin-dir "$root" --model opus --permission-mode default
  --allowedTools Agent Read 'Bash(grep:*)')
cd "$work"

# The session the scene resumes, with a few earlier exchanges so it opens
# mid-work and Claude Code's welcome banner has scrolled away.
session="$(node -e 'console.log(crypto.randomUUID())')"
"${claude[@]}" -p "${history[0]}" --session-id "$session" </dev/null >/dev/null
for prompt in "${history[@]:1}"; do
  "${claude[@]}" -p "$prompt" --resume "$session" </dev/null >/dev/null
done

if [ "$scene" = cold-cache ]; then
  # Two hours and 14 minutes since the last exchange, as the guard's record has it.
  node -e '
    const fs = require("fs"), [dir, session] = process.argv.slice(1)
    const path = dir + "/" + fs.readdirSync(dir).find((n) => n.startsWith("agent-usage-guard_"))
    const store = JSON.parse(fs.readFileSync(path, "utf8"))
    store["last-active:" + session] -= (2 * 60 + 14) * 60_000
    fs.writeFileSync(path, JSON.stringify(store))
  ' "$config/plugins/store" "$session"
fi

"${claude[@]}" --resume "$session"
