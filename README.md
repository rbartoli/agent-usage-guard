# agent-usage-guard

> Stops Claude Code from spending your five-hour usage window in ten minutes.

`agent-usage-guard` is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview): it runs inside Claude Code and holds runaway spend before it happens. It reads your plan's live usage, and it holds subagent fan-out, heavy-context churn and retry loops.

<p align="center">
  <img src="assets/agent-usage-guard.gif" alt="Claude Code's own question dialog carrying agent-usage-guard's question, raised when a fifth parallel audit agent hit the four-agent limit." width="900">
</p>

<p align="center">
  <sub>Recorded from Claude Code's interactive UI against the fictional <a href="demo/fixture/northstar-api">Northstar API fixture</a>. The question on screen is the guard's own, not the model describing it. <a href="demo/agent-usage-guard.tape">Reproduce it with VHS</a> (contacts Claude and uses a little usage).</sub>
</p>

Most usage tools are **monitors**: they tell you what you spent after you spent it. This is a **gate**: it acts before the agent starts, the prompt is sent, or the call runs. When you are at the keyboard it asks you, in Claude Code's own question dialog. When nobody can answer, it refuses and tells Claude why, so the model can wait, batch the work, or stop.

- **Plan-aware.** It reads the 5-hour and weekly percentages Claude Code reports, and keeps the end of the window for you.
- **One keystroke, once.** An approval lasts until the condition clears, so the same thing never asks twice in a row.
- **Local and privacy-minimal.** No network, no processes. It stores counts and coarse buckets, never prompt text, tool inputs or model output.
- **Fails open.** If one of its hooks throws, the event goes ahead: a broken guard never breaks your session.

## Install

Run these commands inside Claude Code v2.1.287 or later:

```text
/plugin marketplace add rblab-io/agent-usage-guard
/plugin install agent-usage-guard@agent-usage-guard
/reload-plugins
```

Then run `/usage-guard` to see what it sees. Mods are on by default; the [overview](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off) lists the settings that turn them off.

## Why this exists

One afternoon I gave Claude Code a research prompt at max effort. It spawned **394 subagent calls, 341 of them running at once, and pushed 84M context tokens through the API in ten minutes.** Session over: *"Claude usage limit reached."* Locked out mid-workday.

That wasn't a one-off. Sixty days of my own logs held **12 lockouts** and 166 ten-minute windows with agent bursts. The failure mode multiplies: *a large context × rapid tool loops × parallel agents × blind retries*. Each protection below removes one factor.

And it's not just me: [339 subagents from a single prompt](https://www.reddit.com/r/ClaudeAI/comments/1u5d02w/), [half a weekly Max plan consumed by recursive spawning](https://github.com/anthropics/claude-code/issues/68619), and multi-agent runs using [~15× the tokens of a chat session](https://www.anthropic.com/engineering/built-multi-agent-research-system).

## What it does

| Area | Rule | Default | What happens |
|---|---|---|---|
| Plan windows | New agents need approval once a window is this full | 80% | asks; approval lasts until that window resets |
| | New agents are refused once a window is this full | 95% | refuses |
| | New agents need approval when the 5-hour window rises this fast | 20 points / 10 min | asks |
| Agents | Agents running at once, across every session on this machine | 4 | asks |
| | Agents started or resumed per 10 minutes, across this machine | 12 | asks |
| | Tokens processed by subagents per 10 minutes, across this machine | 10M | asks |
| | Subagents may not start their own agents | depth 1 | refuses |
| Context | Claude is told once to keep the turn bounded | 300k tokens | adds a note to the prompt |
| | A prompt that would re-read this much context | 500k tokens | asks: compact then send, send anyway, or cancel |
| | Tool calls per 10 minutes while a conversation or agent carries this much | 20 calls at 400k | asks: keep going, compact after this turn, or stop |
| | A heavy session idle long enough for its prompt cache to expire | 150k tokens, 1 h idle | asks before re-writing the cache |
| Loops | The same tool call failing again and again | 3 identical failures | refuses the identical retry |
| | Refused agent calls in a row | 5 in 10 min | pauses agent spawns for 10 min |

Agents covers subagents, agent-team teammates, workflow agents, and finished subagents resumed with `SendMessage`. Each tool call is judged on the context of the loop that makes it, so a small subagent never inherits the main conversation's size.

**When it asks.** The question appears in Claude Code's own dialog, the one Claude uses to ask you something, and the call waits for your answer. Agents started in parallel share one question. If you allow it, the condition stays allowed until it clears: for a plan window, until the window resets. If you decline or dismiss the question, Claude is told not to start agents for the rest of the window, and is not asked again. Typed words reach Claude, so you can answer "use haiku agents instead".

**When nobody can answer.** In `claude -p`, the Agent SDK and `dontAsk` mode, an agent or tool gate refuses instead of asking. A prompt gate holds the prompt and says why. Claude reads each refusal as the tool's result. Repeat refusals of the same condition are worded differently each time and escalate: the second says nothing has changed and to try something else, the third says to end the turn. If a Stop hook such as `/goal` keeps reopening the turn, the refusal says the user has to decide.

**What it leaves alone.** It never holds a background task's notification or another session's message, because that would lose the result. It no longer blocks prompts after a usage limit: since v2.1.234, Claude Code waits at a limit and continues at reset on its own (`autoContinueAtUsageLimit`). The guard's job is to keep you from reaching the limit, and its journal counts the lockouts it did not prevent.

## Commands

```text
/usage-guard                                   what the guard sees right now
/usage-guard allow [agents|context] [minutes]  lift its limits for this session (default: all, 10 min)
/usage-guard resume                            end an allow early, and let declined questions ask again
/usage-guard report [days]                     what it did on this machine (default: 7 days)
```

`/usage-guard` runs at once, even mid-turn, and never starts a model turn, so Claude never sees an override and cannot take one as permission. Sending `[allow-usage-guard]` or `[allow-agent-burst]` alone as a prompt, the markers of earlier versions, does the same as `/usage-guard allow` or `allow agents`.

## What it can and cannot see

Checked against Claude Code v2.1.292:

| Path | Coverage |
|---|---|
| Subagents, teammates and workflow agents | Held before they start (`agent.spawn`) |
| A finished subagent sent new work with `SendMessage` | Held before it resumes, and counted as a start |
| `/subtask` and forked skills | Counted when they start, never held: you start them, and Claude Code offers no event before they do |
| Claude Code's internal agents (prompt suggestions, compaction) | Not counted |
| Plan-window percentages | From the last API response, on a subscription. API-key sessions report none, so only the token and count budgets apply |
| Teammates running in their own terminal panes | Not visible: their loops run in other processes |
| Sessions on other machines | Not counted: the cross-session records live in this machine's mod store |
| Tools the API runs itself, such as the advisor | Not holdable: no tool event fires for them |

Mods run in `claude` in a terminal, in the Desktop app's Code tab, in `claude -p` and the Agent SDK. They don't run in a Desktop-app WSL session ([where mods run](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run)).

**Native limits still matter.** Claude Code caps a session at 20 concurrent subagents (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) and three layers of nesting (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). It has no limit on the total number of agents a session starts. The guard's defaults are stricter and span sessions; the native caps remain the outer wall for the paths the guard only counts.

## See what it did

```text
/usage-guard report 30
```

The report counts usage-limit lockouts per week, plan-window threshold crossings, and every question and refusal by rule, with what you answered. It reads every session's journal on this machine and never leaves it. Set `AGENT_GUARD_JOURNAL=0` to stop recording.

## Security and privacy

A mod runs inside Claude Code with your permissions; read [what a mod can reach](https://code.claude.com/docs/en/plugins/mods/overview#what-a-mod-can-reach) before you install one. This one is small enough to audit, and `claude plugin validate .` lists every API it calls:

- It makes no network requests and starts no processes.
- It keeps its state in the mod store, a JSON file under `~/.claude/plugins/store/`. Each session writes its own counts (running agents, recent starts, token totals, its latest 5-hour reading) and its journal rows (rule, tool name, context bucket such as `400-500k`, plan percentage, and your answer).
- It never stores prompt text, tool inputs, error text or model output. A tool call is reduced to a 13-character fingerprint. Agent names stay in memory and are never written.
- Journal days older than 90 days are deleted (`AGENT_GUARD_JOURNAL_DAYS`).

Set `AGENT_GUARD=0` to turn it off without uninstalling it.

## Configuration

Set these as environment variables, or under `env` in `~/.claude/settings.json`. Times are in seconds; a value that isn't a number in range keeps its default, and `/usage-guard` says so.

| Variable | Meaning (default) |
|---|---|
| `AGENT_GUARD` | `0`, `false` or `off` turns the guard off (`1`) |
| `AGENT_GUARD_JOURNAL` | `0` stops the journal (`1`) |
| `AGENT_GUARD_JOURNAL_DAYS` | Days of journal kept (`90`) |
| `AGENT_GUARD_WINDOW_SECONDS` | Rolling window for budgets, burn and refusals (`600`) |
| `AGENT_GUARD_AGENT_MAX` | Agents running at once on this machine (`4`) |
| `AGENT_GUARD_ROLLING_MAX` | Agent starts and resumes per window on this machine (`12`) |
| `AGENT_GUARD_AGENT_TOKENS_MAX` | Subagent tokens per window on this machine (`10000000`) |
| `AGENT_GUARD_DEPTH_MAX` | Agent layers below the main conversation (`1`) |
| `AGENT_GUARD_LIMIT_ASK_PERCENT` | Plan-window percentage from which new agents ask (`80`) |
| `AGENT_GUARD_LIMIT_DENY_PERCENT` | Plan-window percentage from which new agents are refused (`95`) |
| `AGENT_GUARD_BURN_PERCENT` | 5-hour-window points per window that make new agents ask (`20`) |
| `AGENT_GUARD_CONTEXT_WARN` | Context at which Claude is told once to keep the turn bounded (`300000`) |
| `AGENT_GUARD_CONTEXT_HARD` | Context at which a prompt asks before it is sent (`500000`) |
| `AGENT_GUARD_TOOL_CONTEXT` | Context above which tool calls count against the tool budget (`400000`) |
| `AGENT_GUARD_TOOL_MAX` | Tool calls per window above that context (`20`) |
| `AGENT_GUARD_DORMANT_SECONDS` | Idle time after which a heavy session's cache counts as expired (`3600`) |
| `AGENT_GUARD_DORMANT_CONTEXT` | Context at which an idle session counts as heavy (`150000`) |
| `AGENT_GUARD_DORMANT_MAX` | Heavy dormant resumes per window on this machine when nobody can be asked (`1`) |
| `AGENT_GUARD_TOOL_FAILURE_MAX` | Identical failures before the identical retry is refused (`3`) |
| `AGENT_GUARD_FUSE_MAX` | Refused agent calls per fuse period that pause spawns (`5`) |
| `AGENT_GUARD_FUSE_SECONDS` | The fuse period, and how long the pause lasts (`600`) |
| `AGENT_GUARD_PEER_TTL_SECONDS` | How long another session's counts last after its last model request (`900`) |

The dormant default assumes the one-hour prompt cache that subscriptions get within plan usage. With an API key or extra usage, the cache lasts five minutes, so set `AGENT_GUARD_DORMANT_SECONDS=300`.

## Beyond Claude Code

The rules live in a harness-agnostic core (`core/`) that performs no I/O. The Claude Code mod is its first adapter. [docs/architecture.md](docs/architecture.md) describes the contract an adapter keeps and what another agent harness must offer to carry each rule.

## Tests

```sh
claude plugin validate . --strict
claude plugin test
```

`claude plugin test` runs the suite inside Claude Code's own test kit: unit tests of the core, and tests that fire real Claude Code events through the hooks module with no session, model or network. [TESTING.md](TESTING.md) covers the layers and what each test proves.

## License

MIT
