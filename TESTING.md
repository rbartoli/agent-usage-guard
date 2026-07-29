# Testing strategy

The suite is deliberately behavior-first. The guard is executed as a real hook
process with JSON on stdin, its documented environment variables, a real
temporary transcript, and a real locked/atomic state file. Tests assert public
outcomes—exit status, model-visible stderr or hook output, and privacy-minimal
persisted state—rather than mocking implementation functions.

## Quality gates

Run the dependency-free regression suite:

```sh
python3 agent-usage-guard.test.py
```

Run the same suite with branch-aware subprocess coverage:

```sh
python3 -m pip install coverage==7.10.6
coverage run agent-usage-guard.test.py
coverage combine --quiet
coverage report --include='*/agent-usage-guard.py,*/demo/run_demo.py'
```

Check that the highest-risk tests reject deliberately weakened guard behavior:

```sh
python3 mutation-smoke.py
```

CI also compiles every shipped Python file, runs Ruff lint and format checks,
validates every JSON manifest, validates the Claude plugin contract, runs all
124 tests on Python 3.9–3.14, and rejects branch-aware runtime coverage below
90%. The Python 3.14 job also requires all six targeted mutants to be killed.
Coverage is a backstop, not the test-design target: platform-impossible
fallbacks and defensive malformed-data branches are less important than a
scenario that proves a user-visible invariant.

## Feature-to-test matrix

| Surface | Functional and behavioral evidence |
|---|---|
| Rate/spend/session circuit breaker | Official and legacy `StopFailure` fields; relative, 12-hour, 24-hour, weekday, compound, timezone, invalid-clock fallback, model-scoped Opus limits, category-specific cooldowns, non-shortening cooldowns, expiry, recovery commands, and deliberate override |
| Agent concurrency and rolling budgets | New starts and stopped-agent resumes, permission-safe pending reservations, `PostToolUse` confirmation, `PermissionDenied` and transcript-denial rollback, active leases, completed-history budgets, custom TTLs, nested-agent denial, agent-context ceiling, dormant heavy sessions, aliases, duplicate hooks, out-of-order lifecycle events, and atomic parallel calls |
| Context and tool budgets | Latest real request extraction, `Stop` observation, warning and hard gates, high-context rolling tool counts, compaction boundaries, parent/subagent isolation, recovery commands, and deliberate override |
| Workflow and research gates | Every current Workflow input shape, default-deny `/deep-research`, explicit bypass, high context, max effort in all known payload/transcript shapes, near-exhausted rolling budget, duplicate-notice suppression, and active usage circuit breaker |
| Repeated-failure fuse | Identical versus changed inputs, duplicate tool IDs, interruption semantics, agent-slot rollback, session isolation, warning threshold, retry blocking, and window expiry |
| Denial escalation and agent fuse | Per-fingerprint attempt counting, byte-distinct messages, exact configured durations, non-agent behavior, session scoping, override, and cooldown expiry |
| State, privacy, and crash safety | Corrupt and legacy state migration, malformed/deep/oversized transcripts, missing fields and unknown modes, invalid environment values, unavailable state paths, bounded retention, no prompt/tool/error/output persistence, file locking, and concurrent updates |
| Hook/plugin integration | Runtime dispatch for all 11 modes, exact matchers in both shipped manifests, marketplace metadata, JSON validation, and strict Claude plugin validation |
| Demo and visual artifact | Real launcher invocation against a disposable fixture, exact CLI/environment safety contract, missing-CLI error, cache-file exclusion, GIF structure/dimensions/animation, reviewed golden SHA-256 snapshot, README accessibility text, and reproducible VHS success marker |

## Test layers

- Most tests are subprocess integration tests because process boundaries,
  environment handling, stdin/stdout/stderr, exit codes, locking, and state
  persistence are part of the product contract.
- Concurrency tests invoke independent hook processes against one state file;
  they verify the actual lock and atomic-update behavior.
- Focused structural checks are used only where no runtime UI exists: manifests
  and the recorded terminal GIF.
- The GIF hash is a golden visual regression snapshot. An intentional recording
  update must be viewed, accepted, and accompanied by updating the hash.

The project has no browser or application UI. Its only visual surface is the
documented terminal recording; runtime hook behavior is text/JSON and is tested
functionally instead of with screenshot machinery.
