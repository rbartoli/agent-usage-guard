# Changelog

## Unreleased

- **The README demo shows four scenes** (a cold cache, parallel agents, a heavy-context
  loop and the subagent token budget), recorded from Claude Code against a scripted
  local API so it needs no account and spends no usage: `demo/render.sh`.
- **An agent in a long tool call stays counted.** The 15-minute expiry for
  agents whose end was never reported also caught a live agent blocked in one
  tool, such as a test suite, and nothing counted it again, so one more agent
  could start past the concurrency limit. An agent with a tool call running is
  never expired now, and any agent that makes a request counts as running again.
- **Only a dismissed question counts as a no.** Any other failure of the
  question dialog, such as the turn being interrupted while it was open, was
  read as the user declining: agents were refused for 10 minutes and the
  refusal fed the fuse. Such a failure now fails open.
- **"Compact, then send" never sends at full size.** When compaction failed,
  or a hook vetoed it, the prompt was resent anyway, past the 500k gate. It now
  goes back into the input box with the reason.
- **Notifications leave the context warning for you.** A background task's
  notification above 300k used up the one-time warning, so your own next
  prompt never carried it.
- **Other sessions' subagent tokens age out with the window.** Each session
  published one total that counted for as long as its record lived (15
  minutes, against a 10-minute budget). Records now carry tokens per minute
  (peer record version 2); a session still running an older version is not
  counted until it reloads.
- **A context reading below 400k clears the heavy-context budget.** It revoked
  "Keep going" but kept the call history, so the next heavy call asked again.
- **A `/subtask` fork is counted while a gated agent is starting.** It was
  ignored whenever an agent spawn was pending.
- **The dormant gate works on resumed sessions.** It timed a resumed session's
  idleness from the transcript's modification time, which Claude Code rewrites
  when it resumes a session and hourly while one is open, so `claude --resume`
  and `--continue` never asked before re-writing an expired cache. Each session
  now stores when it was last active in the mod store for 30 days, and a resume
  reads it from there. Found while recording the README demo: a 485k-token
  session resumed after two hours sent its prompt without asking.
- **"Compact, then send" leaves the input box empty.** Claude Code puts a
  dropped prompt back in the input box, so after the guard resent it the box
  still held the prompt, and one more Enter sent it twice. The guard now takes
  it out, unless you have changed it.

## 1.0.0 — 2026-10-07

Rebuilt as a Claude Code mod (Claude Code v2.1.287 or later). The Python command
hooks are gone: the guard now runs inside Claude Code, as a harness-agnostic core
(`core/`) behind a Claude Code adapter (`hooks/register.ts`). A full review of
0.2.5 against Claude Code 2.1.292 found that hooks could only approximate what
mods expose directly: live context, plan-window percentages, and a refusable
event before every agent starts.

- **Plan-aware agent gates.** New agents ask from 80% of a plan window and are
  refused from 95%, and ask when the 5-hour window rises 20 points in ten
  minutes. This is the lever the 2026-08-08 incident lacked: 0.2.5 reacted only
  after a usage limit had already been hit.
- **Every agent path is gated before it starts.** `agent.spawn` covers
  subagents, teammates and workflow agents, so Workflow and `/deep-research` no
  longer need a blanket gate. Resuming a finished subagent with `SendMessage` is
  gated and counted. `/subtask` forks are counted when they start.
- **Questions instead of hard blocks.** When a person can answer, a gate asks in
  Claude Code's own question dialog. An approval holds for a while (a plan
  window until it resets, a heavy context until it shrinks, agent counts for
  10 minutes), which ends the approval fatigue of 0.2.5 (132 of 136
  high-context asks approved, often one per tool call). Without a person (`claude -p`, the SDK,
  `dontAsk`), gates refuse as before.
- **Subagents are judged on their own context.** 0.2.5 read the main
  transcript for a subagent's tool calls, so subagents inherited the parent's
  context and tool budget and could have their report hand-back refused.
- **Approvals are seen, not inferred.** 0.2.5 read an approved dialog back as a
  refusal when the identical call came again, and escalated the denial ladder.
  The mod gets the answer from the dialog.
- **Prompts are no longer held after a usage limit.** Claude Code has waited at
  a limit and resumed at reset since v2.1.234. The 0.2.5 circuit breaker made
  232 refusals that saved nothing, swallowed 31 background-task notifications,
  and kept blocking for 14 minutes after a limit lifted early. Lockouts are
  still journaled; they are the guard's outcome metric.
- **Heavy prompts offer to compact first.** At 500k context a prompt asks:
  compact then send (the prompt is resent as your own words), send anyway, or
  cancel (the prompt goes back in the input box). Dormant heavy sessions ask the
  same way.
- **`/agent-guard` replaces the bracket markers.** It runs without a model turn,
  so the model never reads an override. The old markers sent alone still work.
- **A Stop hook that reopens the turn changes the wording.** All 37 identical
  retries after a denial in 0.2.5's journal followed `/goal` reopening a turn the
  guard had asked to end; refusals now hand that decision to the user.
- **No per-call cost.** The hooks run in-process; 0.2.5 started a Python process
  per tool call, at 110–160 ms each.
- **Removed:** the research gate and the broad-resume prompt patterns, which
  stood in for "a swarm is about to start" and are superseded by per-agent
  gating; the circuit breaker's prompt blocking and its reset-time parsing; the
  state file under `$XDG_STATE_HOME`; the manual settings-hooks install.
- **Changed configuration:** thresholds stay environment variables;
  `AGENT_GUARD_CONTEXT_MAX` is now `AGENT_GUARD_AGENT_TOKENS_MAX`,
  `AGENT_GUARD_HIGH_CONTEXT_TOKENS` is `AGENT_GUARD_DORMANT_CONTEXT`, and the
  block-fuse variables are `AGENT_GUARD_FUSE_MAX` and `AGENT_GUARD_FUSE_SECONDS`.
  New: `AGENT_GUARD_LIMIT_ASK_PERCENT`, `AGENT_GUARD_LIMIT_DENY_PERCENT`,
  `AGENT_GUARD_BURN_PERCENT`, `AGENT_GUARD_DEPTH_MAX`,
  `AGENT_GUARD_PEER_TTL_SECONDS`, `AGENT_GUARD_JOURNAL`,
  `AGENT_GUARD_JOURNAL_DAYS`. Gone with the state file and the circuit breaker:
  `AGENT_GUARD_STATE`, the `AGENT_GUARD_EVENTS*` variables,
  `AGENT_GUARD_PENDING_SECONDS`, `AGENT_GUARD_LEASE_SECONDS`,
  `AGENT_GUARD_KNOWN_AGENT_SECONDS`, `AGENT_GUARD_RESEARCH_CONTEXT`,
  `AGENT_GUARD_RATE_COOLDOWN_SECONDS`, `AGENT_GUARD_SESSION_COOLDOWN_SECONDS`,
  `AGENT_GUARD_MAX_EFFORT_AGE` and `AGENT_GUARD_NOW`.
- **Robust under parallel calls.** Calls that trip while a question is open
  are held back at once instead of waiting on it, so no hook outlives its
  10-second limit; an agent the guard could not judge in time is refused, not
  started. The retry fuse counts identical failures only when nothing else ran
  in between, so test, edit, re-run is never a loop. `/agent-guard resume` and
  `allow` lift the agent pause. The journal stays under 2 MB of the store, and
  a subagent's permission mode no longer decides whether the guard can ask.
- Tests run in Claude Code's mod test kit (`claude plugin test`), including a
  parallel batch of five agents against a limit of four, a race the first draft
  of the mod got wrong.

## 0.2.5 — 2026-08-16

- Drop the stray `U` from the prompt-denial banner. 0.2.4 rendered
  `🛡️U USAGE GUARD`; it is `🛡️USAGE GUARD`.

## 0.2.4 — 2026-08-16

- Label prompt-side denials `🛡️U USAGE GUARD` and suppress Claude Code's "Original
  prompt:" dump. A background-task `<task-notification>` under a session limit
  was rendering as a generic hook error plus the XML envelope. Circuit-breaker
  copy now says new work waits until reset (⏳), and names a finished
  background task (📬) when that is what was blocked.

## 0.2.3 — 2026-08-15

- Throttle high-context warnings per session, not per request id. Successive
  turns in the same heavy session were each a new request, so the 10-minute
  notice window never hit and the journal filled with repeats of the same warn.

- Count the deny ladder by condition for session-level rules (high-context
  turn, active/rolling/nested/agent-context), not by tool-input hash. A refused
  5th agent then a different 5th is denial 2; a different Bash under a
  high-context turn is too. Agent-budget silent-refusal inference matches a
  stale pending reservation in the same session. Tool-error fuse stays
  per-fingerprint. Ladder copy names "this condition" rather than "this exact
  call" on those trips.

- Record `tool_name` and a coarse `context_bucket` on journal interventions, and
  summarise both in `report`. Still no prompt text or tool inputs.

## 0.2.2 — 2026-08-08

- Stay out of agent CLIs that are not Claude Code. Cursor Agent imports the
  plugins enabled in `~/.claude/settings.json` and runs their hooks under its
  own event names, so the guard was refusing Cursor prompts on the strength of
  a Claude session's context and usage — advice that host cannot act on, with
  `/compact` and the escape markers both meaningless there. Cursor exports
  `CURSOR_PLUGIN_ROOT` beside the `CLAUDE_PLUGIN_ROOT` compatibility alias;
  the guard now sees it, exits 0, and records nothing. Found by dogfooding.

- Run CI on the organisation's shared self-hosted runners, which is why the org
  exists. The lane had been asking for `ubuntu-latest` and could not start at
  all, so nothing it checked was ever reported: Python 3.9 now comes from `uv`
  because the runners are Ubuntu 26.04, for which `actions/python-versions`
  publishes no 3.9 build, and three findings ruff 0.16.0 had been unable to
  report are fixed — ISC004 on the report header, EXE001 on `mutation-smoke.py`,
  and the formatter drift `main` predated.

## 0.2.1 — 2026-08-06

- Record local interventions in a privacy-minimal journal and ship `report` so
  anyone running the guard can see what it successfully stopped on that
  machine. Writes only on deny, ask, notice, override arm, circuit arm, and
  fuse trip — not on every allow. The journal stays on disk
  (`events.jsonl` beside the state file), never includes prompt or tool
  content, and fails open so a bad journal path cannot change allow/deny.
  Disable with `AGENT_GUARD_EVENTS=0`.

- Stop treating one model's exhaustion as an account-wide stop. Running out of
  usage credits for a single model armed the spend circuit breaker globally,
  and switching model did not clear it: the session stayed blocked for the full
  cooldown while the denial itself listed `/model` as an allowed recovery
  command that could not actually recover anything. The rule already existed
  for Opus plan limits but was matched on the word "opus" and applied only to
  `rate_limit`, so credit exhaustion - a billing failure naming any other model
  - fell straight through. The signal is now the remedy Claude Code prints,
  which offers a model switch only when another model still works, and it is
  read for both error types. A limit that offers no switch is still account-
  wide and still arms the circuit. Found by dogfooding.

- Infer a silent refusal for escalations that reserve nothing. The inference
  read only agent reservations, which just one kind of escalation writes, so a
  refused Workflow or a refused context/tool-error trip on an ordinary tool
  produced no refusal signal at all: the ladder reported "denial 1" on every
  retry, the agent fuse behind it could never trip, and each attempt left
  another unused tool event counting against the high-context tool budget.
  Those escalations are now marked on the tool event, and an unresolved marker
  is read back the same way a reservation is. A direct agent action is excluded
  deliberately - its reservation is cleared when the agent starts, so approval
  is observable there, while a tool event has no such lifecycle and marking one
  would charge a denial to a call the user allowed. With nothing to confirm a
  Workflow ran, that inference is bounded by the rolling window: an identical
  call inside it is the retry the ladder counts, a later repeat is a fresh
  decision.

- Accumulate prompt notices instead of letting the last one win. The
  confirmation that a bypass armed shared one slot with the high-context
  warning, so arming `[allow-agent-burst]` in a heavy session produced only the
  warning. The override still armed in state, which is the worst version of the
  failure: nothing distinguished a live bypass from a marker that did nothing.
  The near-miss hint lost the same race. Both now surface alongside the
  warning, under a single `USAGE GUARD:` prefix.

- State where an escape marker has to go, everywhere one is named. Twelve of
  the thirteen denials that advertised a bypass named the marker and stopped
  there, which points the reader straight at the one placement that arms
  nothing: the marker typed ahead of the retry, on the same line. Only a
  *leading* misplacement is warned about - a marker later in the prompt is
  indistinguishable from the prose mention strictness exists to ignore - so the
  denial that offers the escape hatch is the only reliable place to say the
  rule. A test now drives every such denial and fails if one names a marker
  without it. Found by dogfooding, where three consecutive bypass attempts
  armed nothing and only one of them explained why.

- Escalate `PreToolUse` guard trips to the user instead of denying them
  outright. A tripped agent budget, context gate, tool-error fuse, or Workflow
  now returns `permissionDecision: "ask"`, which raises Claude Code's own
  permission dialog: overriding a limit you meant to cross is a keystroke
  rather than a retyped prompt carrying an escape marker. Prompt-side guards
  are unchanged, because `UserPromptSubmit` has no interactive decision - and
  for the context guards it could not have one anyway, since the API call that
  would carry the question is the context rebuild they exist to prevent.
- Reserve capacity for an escalated call rather than only for an allowed one.
  `PostToolUse` ignores any call with no reservation behind it, so an approved
  escalation would otherwise have run entirely outside the rolling budget.
  `PermissionDenied` releases the reservation on a refusal, as it already did.
- Fall back to a hard `deny` in `bypassPermissions` and `dontAsk`, which
  suppress the dialog an ask depends on. An escalation raised there would be
  auto-approved, silently disabling every tool-side guard in exactly the mode
  where a runaway is most likely - the demo runner itself uses
  bypassPermissions. The guard reads `permission_mode` off the payload.
- Rebuild the terminal demo so the recording shows the guard rather than a
  paraphrase of it. The old tape instructed Claude to write "GUARD TRIGGERED"
  and waited for that string, so the headline asset carried model prose, not
  hook output - and it kept passing after 0.2.0 moved the default ceiling from
  two agents to four, leaving a GIF that stated a limit the guard no longer
  had and showed the "denied" agent as finished. The prompt now simply asks for
  five parallel audits against a ceiling of four, the runner drops
  bypassPermissions so the permission dialog can render the guard's own
  message, and the wait matches that hook text. Tests reject a tape that tells
  the model what to say.
- Advance the refusal ladder by inference rather than at `PreToolUse`. An ask
  has no outcome at decision time, so recording it inline would have charged a
  denial to a call the user approved. Refusing a guard-raised dialog turns out
  to emit nothing at all - verified live against 2.1.220 for both "No" and Esc,
  no `PermissionDenied` - so an escalated reservation still unresolved when the
  identical call comes back is read as a refusal: an approved one would have
  been confirmed into a lease, and the model cannot re-propose while its own
  dialog is open. That reclaims the orphaned reservation instead of leaving it
  to expire. The two hard-refusal states - a burning agent fuse and the attempt
  that trips it - still deny with exit 2 and record inline.

## 0.2.0 — 2026-07-27

- Recalibrate the default agent budgets for real-world parallel work: four
  concurrent subagents (was two), twelve starts/resumes per rolling window
  (was six), and a 10M-token per-window subagent context ceiling (was 20M).
  Ordinary multi-agent review passes no longer trip the guard, while a
  runaway burst is still capped at a small fraction of the observed
  incidents. The recommended native backstops become the looser outer wall
  (4 concurrent, 25 per session, depth 1) so `[allow-agent-burst]` keeps
  headroom to work.
- Default-deny opaque `Workflow` runs, including `/deep-research`, unless an
  override was explicitly armed.
- Split provisional agent reservations from confirmed active leases and rolling
  history. Reconcile manual and permission-rule denials from the transcript,
  with a five-minute pending fallback TTL.
- Confirm background Agent and SendMessage attempts through `PostToolUse`, and
  preserve agent name-to-ID aliases across resumes.
- Parse weekday and 24-hour reset clocks and accept the Claude Code 2.1.220
  `StopFailure` payload fields.
- Keep compaction boundaries beyond the rolling window and avoid globally
  blocking other models after an Opus-only limit.
- Require escape markers as standalone first-line directives.
- Name the alternatives in the first denial, not only from the second. Mining
  130 real denials out of local transcripts put the identical-retry rate near
  44%, with escalation dropping sharply at denial 2 - the first rung that
  offered a way forward, where denial 1 had stated only the condition. A few
  extra tokens are cheap against a retry that re-sends the whole conversation.
  The wording stays factual rather than imperative and byte-distinct from the
  later rungs.
- Say so when a prompt opens with an escape marker but puts other text on the
  same line. The matcher stays strict - that is what stops a marker quoted in
  prose from lifting the limits - but a marker that *leads* the line no longer
  fails silently: the reason is appended to the denial, or surfaced as a notice
  when nothing blocked. Found by dogfooding, where every override attempt on
  record had been silently inert.
- Deny prompt and `/research` events with a decision document so Claude Code
  prints the guard's reason on its own. A bare exit 2 made it prefix the reason
  with the configured hook command, which on a plugin install is the literal
  unexpanded `${CLAUDE_PLUGIN_ROOT}/agent-usage-guard.py` and reads as a broken
  path. The exit code stays 2, so the denial holds even if that stdout is
  ignored. `PreToolUse` keeps the stderr-only path until its reservation
  accounting has been exercised against a decision document.
- Scan transcripts backwards for the latest model request instead of parsing a
  full 4 MiB tail on every tool call.
- Retain rolling records on a process-independent 24-hour horizon so
  mixed-window processes preserve one another's evidence without unbounded
  state growth.
- Correct the documented hook model and disclose `/subtask` and forked-skill
  pre-spawn limitations.
