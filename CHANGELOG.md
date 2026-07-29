# Changelog

## Unreleased

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
- Advance the refusal ladder from `PermissionDenied` rather than at
  `PreToolUse`. An ask has no outcome at decision time, so recording it inline
  would have charged a denial to a call the user approved. Only real refusals
  now count, and the two hard-refusal states - a burning agent fuse and the
  attempt that trips it - still deny with exit 2 and raise no dialog.

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
  prose from lifting the limits - but a misplaced marker no longer fails
  silently: the reason is appended to the denial, or surfaced as a notice when
  nothing blocked. Found by dogfooding, where every override attempt on record
  had been silently inert.
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
