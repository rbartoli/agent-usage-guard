#!/usr/bin/env python3
"""Targeted mutation smoke test for the guard's highest-risk invariants."""

from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GUARD = ROOT / "agent-usage-guard.py"
TESTS = ROOT / "agent-usage-guard.test.py"

MUTATIONS = (
    (
        "active limit 4 -> 5",
        "DEFAULT_ACTIVE_AGENT_MAX = 4",
        "DEFAULT_ACTIVE_AGENT_MAX = 5",
        "test_agent_starts_share_the_same_four_slots",
    ),
    (
        "rolling limit 12 -> 13",
        "DEFAULT_AGENT_START_MAX = 12",
        "DEFAULT_AGENT_START_MAX = 13",
        "test_rolling_agent_budget_survives_agent_completion",
    ),
    (
        "hard context 500k -> 600k",
        "DEFAULT_CONTEXT_HARD = 500_000",
        "DEFAULT_CONTEXT_HARD = 600_000",
        "test_default_context_hard_limit_boundary",
    ),
    (
        "failure threshold 3 -> 4",
        "DEFAULT_TOOL_FAILURE_MAX = 3",
        "DEFAULT_TOOL_FAILURE_MAX = 4",
        "test_identical_tool_failure_fuse_warns_blocks_and_expires",
    ),
    (
        "disable Workflow recognition",
        'is_workflow = tool_name == "Workflow"',
        "is_workflow = False",
        "test_workflow_is_denied_for_every_current_input_shape",
    ),
    (
        "weaken override directive matching",
        "return stripped == marker",
        "return marker in stripped",
        "test_escape_marker_mentions_do_not_activate_an_override",
    ),
)


def main() -> int:
    spec = importlib.util.spec_from_file_location("guard_tests", TESTS)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {TESTS}")
    tests = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tests)
    source = GUARD.read_text(encoding="utf-8")
    killed = 0

    with tempfile.TemporaryDirectory(prefix="agent-guard-mutations-") as tmp:
        mutant = Path(tmp) / GUARD.name
        for name, original, replacement, test_name in MUTATIONS:
            matches = source.count(original)
            if matches != 1:
                raise RuntimeError(
                    f"{name}: expected one mutation target, found {matches}"
                )
            mutant.write_text(
                source.replace(original, replacement),
                encoding="utf-8",
            )
            mutant.chmod(0o755)
            tests.GUARD = mutant
            try:
                getattr(tests, test_name)()
            except AssertionError:
                killed += 1
                print(f"killed  {name}")
            else:
                print(f"SURVIVED {name}")

    print(f"\n{killed}/{len(MUTATIONS)} targeted mutants killed")
    return 0 if killed == len(MUTATIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
