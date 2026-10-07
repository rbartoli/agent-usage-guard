# Architecture

agent-usage-guard is a policy core with one adapter per agent harness. The
core decides; an adapter observes the harness, asks the core, and carries out
the verdict. Claude Code is the first harness, through a
[mod](https://code.claude.com/docs/en/plugins/mods/overview) in
`hooks/register.ts`.

```text
core/                    harness-agnostic: no I/O, no clock, no dependencies
  config.ts              thresholds from a record of strings (env vars here)
  state.ts               SessionState and PeerRecord: plain JSON
  observe.ts             facts after they happen: responses, limits, agents, tool results
  agents.ts              the agent gate: spawns, resumes, workflow agents
  tools.ts               the tool gate: retry fuse, heavy-context tool budget
  prompts.ts             the prompt gate: heavy prompts, dormant resumes, warning
  verdict.ts             verdict types and the denial ladder with the agent fuse
  lockout.ts             which failures were usage-limit lockouts
  journal.ts             journal rows, retention and the report
  status.ts, commands.ts what the user sees, and /usage-guard
  text.ts                formatting, fingerprints
  index.ts               the core's public entry point
hooks/register.ts        the Claude Code adapter: the only file that calls the mods API
```

## What the core promises

- **Pure and synchronous.** Every function takes the state, the config and
  `now`, and returns a verdict. Nothing awaits, so an adapter that serves
  concurrent events in one process can call it from any of them: no update
  stops halfway.
- **Plain JSON state.** `SessionState` and `PeerRecord` hold numbers, strings,
  arrays and records. An adapter can keep them in memory, in a key-value store,
  or in a file that a hook process reads and writes on each event.
- **Portable TypeScript.** Standard ECMAScript only, imported with explicit
  `.ts` extensions, so Bun, Deno and Node's type stripping all load it as-is.
- **Counts, not content.** Nothing the core stores or returns for storage
  holds prompt text, tool inputs or model output. Tool calls are reduced to an
  FNV-1a fingerprint of their canonical JSON.

## What an adapter does

An adapter maps the harness onto these calls. The Claude Code adapter's
handler for each is named in brackets.

| Moment | Core call | Claude Code |
|---|---|---|
| A model request finished | `observeResponse(state, config, now, loop, usage)` | `turn.step` |
| Plan-window readings arrived | `observeLimits(state, config, readings)` | `session.measure` |
| An agent is about to start | `agentGate(...)`, then `reserveStart` in the same synchronous step | `agent.spawn` |
| A finished agent is sent new work | `agentGate(..., { resume: true })` | `tool.call` for `SendMessage` |
| An agent started or finished a run | `observeSpawn`, `releaseStart`, `observeAgentRunEnd` | `agent.spawn` result, `turn.complete` |
| A tool is about to run | `toolGate(...)` | `tool.call` |
| A tool finished | `observeToolResult(state, now, loop, fingerprint, failed)` | `tool.call` after `next` |
| A prompt is about to be sent | `promptGate(...)` | `prompt.submit` |
| A request failed | `lockoutKind(error, text, readings)` | `classic.StopFailure` |
| The conversation compacted | `observeCompaction(state)` | `classic.PostCompact`, `classic.SessionStart` with source `compact` |

A verdict is one of:

- `allow`, optionally with a `note` the model should read with the prompt;
- `deny`, with a `message` for the model, already worded by the ladder;
- `drop`, with a `message` for the user, for a prompt that is not sent;
- `ask`, with a question and options. The adapter puts the question to the
  person and hands the answer to `resolveAgentAsk` (a verdict),
  `resolveHeavyAsk` (a verdict, plus whether to compact after the turn) or
  `resolvePromptAsk` (a verdict, or `compact-then-send`), and carries out what
  comes back. A harness with nobody to
  ask sets `state.canAsk = false`, and the core then refuses instead of asking.

Two duties fall on every adapter, because only it knows the harness:

1. **One question at a time per family.** Parallel calls that trip while a
   question is open are refused at once with `heldForQuestion`, which asks the
   model to retry after the answer and feeds neither the ladder nor the fuse.
   Waiting for the answer instead could outlast a hook's time limit.
2. **Reserve in the same step as the verdict.** Parallel spawns are judged
   concurrently; `reserveStart` right after an allowing `agentGate` is what
   makes a batch of five against a limit of four let exactly four through.

## Sessions on one machine

Each session publishes a `PeerRecord`: running agents, recent starts, subagent
tokens, recent dormant resumes, and its latest 5-hour reading. The gates sum
fresh peer records with the session's own state, so the agent limits hold
across every session on the machine. A record counts only while its session
keeps making model requests (`AGENT_GUARD_PEER_TTL_SECONDS`), so a crashed
session's agents stop counting on their own. Each session writes only its own
key, so writes never race.

## Adding a harness

What a harness offers decides how much of the guard it can carry:

- **In-process plugins with a pre-tool hook** (Claude Code mods, OpenCode
  plugins and their `tool.execute.before` hook): the whole guard. Import
  `core/` and write an adapter like `hooks/register.ts`.
- **Command hooks run per event** (Codex CLI's `PreToolUse`, Gemini CLI's
  `BeforeTool`, Claude Code settings hooks): the gates that need only that
  event's payload. The
  adapter is a small script that loads `SessionState` from a file, calls the
  core, saves it, and prints the harness's decision format. Plan-window
  readings exist only where the harness exposes them.
- **A proxy in front of the model API** (LiteLLM and similar): request-level
  accounting for any harness, but no view of agents or tools, and nobody to ask.

An adapter needs these from its harness, from most to least important: a hook
before each tool call that can refuse it; token usage per model request; a way
to tell subagent requests from the main loop's; the plan's usage percentages;
and a way to ask the person a question.
