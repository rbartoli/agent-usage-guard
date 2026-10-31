# Testing

The suite runs inside Claude Code's own mod test kit (`claude plugin test`):
no session, sign-in, model or network. Tests assert what a user or the model
would see (verdicts, question text, held prompts, journal rows), not internal
calls.

## Gates

```sh
claude plugin validate . --strict   # manifest, hooks module, static analysis
claude plugin test                  # every tests/*.test.ts
```

CI runs both on GitHub-hosted runners against the pinned Claude Code version in
`.github/workflows/test.yml`. Type-checking needs the declarations Claude Code
writes when an interactive session loads the mod from its folder (`claude -p`
does not write them), so it runs locally:

```sh
claude --plugin-dir .                       # start it, then quit: writes .claude-plugin/types/
npx -p typescript@5.9 tsc -p tsconfig.json
```

## Layers

- **Core unit tests** (`tests/core.test.ts`) call the harness-agnostic core
  directly with plain data: config parsing, command parsing, the denial
  ladder, plan-window selection, peer records, fingerprints, and the report.
- **Mod tests** (every other file) load the real hooks module and fire Claude
  Code events through it (`agent.spawn`, `tool.call`, `prompt.submit`,
  `turn.step`, `session.measure`, classic hook events). `tests/harness.ts`
  stubs every mods API call the module makes: an in-memory store, a mock
  clock, a question dialog that answers from a script, and recorders for
  status lines, compactions and resubmitted prompts.

## What the tests prove

| Surface | Evidence |
|---|---|
| Agent limits | Concurrency, rolling starts and subagent tokens; a finished agent frees its slot, one in a long tool call keeps it, and one that went quiet counts again at its next request; peers' counts add up, their tokens age out with the window, and stale or malformed records expire or are ignored; a parallel batch of five lets exactly four through; nesting refused; resumes by `SendMessage` gated and counted once, also when Claude Code raises `agent.spawn` for them; a resume through `agent.spawn` alone gated as a resume; `/subtask` forks counted, even while a gated agent is starting, internal agents not |
| Plan windows | Refused from 95%, wakeups and scheduled jobs too, while other tools run and an allow lifts it; asked once from 80% with the approval lasting to reset; weekly window; expired windows ignored; burn rate, and a pace that would fill the window before it resets, but not a slower one or a one-point blip; threshold crossings journaled once |
| Questions | Approval leases the condition; declining refuses without asking again; typed answers reach the model; a question that ends without an answer, however it ends, counts as dismissed and never as a yes; an agent the guard failed to judge is refused; calls made while a question is open are held back without waiting, and run once it is answered |
| Tool gate | Retry fuse on identical failures in a row only, so test, edit, re-run is not a loop; a permission refusal is not a failure; the heavy-context budget asks once, stops the turn, or compacts after it; subagents judged on their own context, and named in a question only by a plain name; `SubagentHandback` and `TaskStop` never held; compaction, or a context reading below the threshold, clears the budget |
| Prompt gate | Heavy prompt asks, compacts first, or cancels, and the prompt waits in the input box either way, never sent by the guard; a compaction that fails or a hook vetoes says so; headless, scheduled and relayed prompts hold with a reason, and never lift limits; notifications pass untouched; dormant resumes ask or are capped across sessions; the context warning is given once, on a prompt the user typed; from 95% of a plan window, read in any session, each session is told once to wind down, and again only in a new window; a session compacted while idle is not asked |
| Denials | Each refusal of a condition reads differently and escalates; separate conditions count separately; the fuse pauses spawns and clears, and `resume` lifts it; a Stop hook reopening the turn changes the wording |
| Overrides | `/agent-guard allow`, `resume`, the old markers sent alone, and the off switch; `allow` and `pause` refused when another plugin runs them |
| Status line | Redrawn when a plan window it shows resets or an allow ends, in a session where nothing else happens; says when the store stops saving, and clears once a save works |
| Journal | Lockouts classified (usage, weekly, spend, one model) and transient rate limits ignored; each locked window counted once, across sessions and retries; report across sessions, from rows that hold only the values the guard writes; retention and stale-record cleanup; rows hold no prompt text |

## What is checked by hand

On Claude Code 2.1.292, the question dialog, the status line and
`/agent-guard` were exercised in a real interactive session of this mod. On
2.1.296, an idle session's status line cleared itself when `/agent-guard allow 1`
ran out. On 2.1.316, with `AGENT_GUARD_CONTEXT_HARD` lowered to 10k, "Compact
first" compacted a 58k session to 20k and left the prompt in the input box
once, and "Cancel" left it there once. The demo recording in
`demo/` reproduces the main path against the real UI and uses a little usage.
