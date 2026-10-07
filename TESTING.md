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
writes when it loads the mod with `--plugin-dir`, so it runs locally:

```sh
claude -p "/usage-guard" --plugin-dir .   # writes .claude-plugin/types/
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
| Agent limits | Concurrency, rolling starts and subagent tokens; a finished agent frees its slot; peers' counts add up and stale records expire; a parallel batch of five lets exactly four through; nesting refused; resumes by `SendMessage` gated and counted; `/subtask` forks counted, internal agents not |
| Plan windows | Refused from 95%, asked once from 80% with the approval lasting to reset; weekly window; expired windows ignored; burn rate; threshold crossings journaled once |
| Questions | Approval leases the condition; declining refuses without asking again; typed answers reach the model; parallel calls share one question |
| Tool gate | Retry fuse on identical failures only; a permission refusal is not a failure; the heavy-context budget asks once, stops the turn, or compacts after it; subagents judged on their own context; `SubagentHandback` and `TaskStop` never held; compaction clears the budget |
| Prompt gate | Heavy prompt asks, compacts then resends as the user's own words, or cancels back into the input box; headless holds with a reason; notifications pass; dormant resumes ask or are capped across sessions; the context warning is given once |
| Denials | Each refusal of a condition reads differently and escalates; separate conditions count separately; the fuse pauses spawns and clears; a Stop hook reopening the turn changes the wording |
| Overrides | `/usage-guard allow`, `resume`, the old markers sent alone, and the off switch |
| Journal | Lockouts classified (usage, weekly, spend, one model) and transient rate limits ignored; report across sessions; retention and stale-record cleanup; rows hold no prompt text |

## What is checked by hand

On Claude Code 2.1.292, the question dialog, the status line and
`/usage-guard` were exercised in a real interactive session of this mod, and
the compact-then-send flow (drop, compact from a timer, resend as the user) in
a probe mod built on the same calls. The demo recording in `demo/` reproduces
the main path against the real UI and uses a little usage.
