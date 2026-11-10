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
| Agent limits | Concurrency, rolling starts and subagent tokens; Haiku agents left out of the first two, whether asked for or picked by their definition, unless switched off; a finished agent frees its slot, one in a long tool call keeps it, and one that went quiet counts again at its next request; peers' counts add up, their tokens age out with the window, and stale or malformed records expire or are ignored; a parallel batch of five lets exactly four through; nesting refused; resumes by `SendMessage` gated and counted once, also when Claude Code raises `agent.spawn` for them; a resume through `agent.spawn` alone gated as a resume; `/subtask` forks counted, even while a gated agent is starting, internal agents not |
| Plan windows | Refused from 95%, wakeups and scheduled jobs too, while other tools run and an allow lifts it; asked once from 80% with the approval lasting to reset; weekly window; expired windows ignored; burn rate, and a pace that would fill the window before it resets, but not a slower one, a short burst that fills it only hours later, or a one-point blip; threshold crossings journaled once |
| Questions | Approval leases the condition; declining refuses without asking again; typed answers reach the model; a question that ends without an answer, however it ends, counts as dismissed and never as a yes; an agent the guard failed to judge is refused; calls made while a question is open are held back without waiting, and run once it is answered |
| Tool gate | Retry fuse on identical failures in a row only, so test, edit, re-run is not a loop; a permission refusal is not a failure; the heavy-context budget asks once, stops the turn, or compacts after it; subagents judged on their own context, and named in a question only by a plain name; `SubagentHandback` and `TaskStop` never held; compaction, or a context reading below the threshold, clears the budget |
| Prompt gate | Heavy prompt asks, compacts then resends as the user's own words, or cancels back into the input box, never doubled; a prompt with an image or an @ mention waits there after compacting; a compaction that fails or a hook vetoes puts the prompt back, ahead of anything typed since; headless, scheduled and relayed prompts hold with a reason, and never lift limits; notifications pass untouched; dormant resumes ask or are capped across sessions; the context warning is given once, on a prompt the user typed; from 95% of a plan window, read in any session, each session is told once to wind down, and again only in a new window; a session compacted while idle is not asked |
| Denials | Each refusal of a condition reads differently and escalates; separate conditions count separately; the fuse pauses spawns and clears, and `resume` lifts it; a Stop hook reopening the turn changes the wording |
| Overrides | `simulate` trips every rule with the defaults, opens the real question or prints the refusal, and changes nothing; `/agent-guard allow`, `resume`, the old markers sent alone, and the off switch; `allow` and `pause` refused when another plugin runs them |
| Status line and band | Redrawn when a plan window it shows resets or an allow ends, in a session where nothing else happens; says when the store stops saving, and clears once a save works; the band shows nothing with nothing to say, counts agents across sessions, shows an open question, a decline and the last refusal, clears on its own as they age out, and draws only where someone is at the keyboard |
| Managed machines | With a stand-in for Claude Code's `cc-plugin-sec-default`, which passes every classic event over the guard: a compaction clears the context the prompt gate held; a usage-limit lockout is journaled by window when its turn ends, and other API errors are not; a session resumed in place is judged as itself; a Stop hook's reopen still changes the wording; "Compact, then send" and the agent gate still work |
| Journal | Lockouts classified (usage, weekly, spend, one model) and transient rate limits ignored; each locked window counted once, across sessions and retries; report across sessions, from rows that hold only the values the guard writes; retention and stale-record cleanup; rows hold no prompt text |

## What is checked by hand

On Claude Code 2.1.292, the question dialog, the status line and
`/agent-guard` were exercised in a real interactive session of this mod. On
2.1.296, an idle session's status line cleared itself when `/agent-guard allow 1`
ran out. On 2.1.316, with `AGENT_GUARD_CONTEXT_HARD` lowered to 10k, "Compact,
then send" emptied the input box, compacted, and sent the prompt once, under
"Prompt from the agent-usage-guard plugin". A prompt with an @ mention was
compacted for (55k to 17k) and left in the box once, and "Cancel" left the
prompt there once. On 2.1.318, a probe mod saw a turn
refused with a 429 end in `turn.complete` with reason `error`, the transcript's
last message holding the error Claude Code showed; a `/clear` give the new
session id at the next prompt; and `$.session.usage()` hold no context figure
from a `/compact` until the next response. Claude Code's real
`cc-plugin-sec-default` was then seated by giving one process a managed-settings
file: `bwrap` mounted a fresh `/etc` with each real entry bound back in, plus
`/etc/claude-code/managed-settings.json` holding one harmless setting (an empty
one doesn't seat it). Against a scripted API, 1.2.0-rc.3 journaled a usage-limit
lockout, sent the first prompt after `/compact` without the "compact first?"
question, filed the journal under the new session id after `/clear`, and worded
the second refusal in a turn a Stop hook reopened as the user's decision.
1.2.0-rc.2, without the fix, did none of the four. The demo recording in
`demo/` reproduces the main path against the real UI and uses a little usage.

Before the 1.2.0 release, 1.2.0-rc.3 ran in real interactive sessions on
2.1.318 against a scripted API, which spends no usage. With
`cc-plugin-sec-default` seated and without: at a cap of one agent, the second
opened the question, and after "Don't start it" the band showed the decline
and the last refusal; three Haiku agents started without a question; and
"Compact, then send" compacted once and sent the prompt once. Without it, the
four checks above passed too; one 429 journaled one lockout, not two; a cron
prompt that fired at a heavy context was held; each `simulate` rule printed its
simulation; a read-only store turned the status line to "store not saving";
and a copy of a real 1.1.3 store read back in `status` and `report`. Claude
Code's question dialog replaces the prompt area while it is open, so the band's
"asking you about …" never shows in the terminal.
