#!/usr/bin/env python3
"""Launch the real interactive Claude Code UI for the terminal demo.

The working repository is a disposable copy of the fictional Northstar API
fixture. This launcher does not render or replay Claude output; stdin, stdout,
and stderr remain attached to the terminal so the recording captures Claude
Code's actual interactive interface.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "demo" / "fixture" / "northstar-api"
EMPTY_MCP_CONFIG = ROOT / "demo" / "empty-mcp.json"


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Launch interactive Claude Code in the sanitized demo fixture."
    )
    value.add_argument(
        "--model",
        default=os.environ.get("AGENT_GUARD_DEMO_MODEL", "fable"),
        help="Claude model alias or full model name (default: fable)",
    )
    return value


def main() -> int:
    args = parser().parse_args()
    claude = shutil.which("claude")
    if claude is None:
        raise SystemExit("Claude Code is required but was not found on PATH.")

    with tempfile.TemporaryDirectory(prefix="agent-usage-guard-demo-") as tmp:
        workdir = Path(tmp)
        shutil.copytree(
            FIXTURE,
            workdir,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )

        env = os.environ.copy()
        env.update(
            {
                "AGENT_GUARD_STATE": str(workdir / "guard-state.json"),
                "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "20",
                "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION": "20",
                "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1",
            }
        )
        command = [
            claude,
            "--plugin-dir",
            str(ROOT),
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--mcp-config",
            str(EMPTY_MCP_CONFIG),
            "--tools",
            "Agent,Read",
            "--model",
            args.model,
            "--effort",
            "low",
            "--permission-mode",
            "bypassPermissions",
            "--exclude-dynamic-system-prompt-sections",
            "--session-id",
            str(uuid.uuid4()),
            "--name",
            "agent-usage-guard-demo",
        ]
        return subprocess.call(command, cwd=workdir, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
