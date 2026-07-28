# Changelog

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
