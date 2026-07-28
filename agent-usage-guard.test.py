"""Dependency-free regression tests for agent-usage-guard.py."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

GUARD = Path(__file__).with_name("agent-usage-guard.py")
ROOT = GUARD.parent
NOW = 2_000_000_000


def invoke(
    mode: str,
    payload: dict,
    state: Path,
    *,
    now: int = NOW,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "AGENT_GUARD_STATE": str(state),
            "AGENT_GUARD_NOW": str(now),
        }
    )
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(GUARD), mode],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert proc.returncode in (0, 2), f"guard crashed: {proc.stderr}"
    return proc


def assistant_record(
    timestamp: int, context: int, request_id: str | None = None
) -> dict:
    return {
        "type": "assistant",
        "timestamp": datetime.fromtimestamp(timestamp, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "requestId": request_id or f"req-{timestamp}",
        "message": {
            "model": "claude-opus-test",
            "usage": {
                "input_tokens": 1,
                "cache_creation_input_tokens": context - 1,
                "cache_read_input_tokens": 0,
            },
        },
    }


def write_transcript(
    path: Path,
    timestamp: int,
    context: int,
    *,
    request_id: str | None = None,
    extra_records: list[dict] | None = None,
) -> None:
    records = list(extra_records or [])
    records.append(assistant_record(timestamp, context, request_id))
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


def user_record(timestamp: int, text: str) -> dict:
    return {
        "type": "user",
        "timestamp": datetime.fromtimestamp(timestamp, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "message": {"role": "user", "content": text},
    }


def prompt_payload(
    prompt: str,
    session: str = "session-a",
    transcript: Path | None = None,
) -> dict:
    value = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": session,
        "prompt": prompt,
    }
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    return value


def send_payload(
    tool_id: str,
    target: str,
    message: str = "Continue exactly where you left off and finish the scope.",
    session: str = "parent-a",
    transcript: Path | None = None,
) -> dict:
    value = {
        "hook_event_name": "PreToolUse",
        "session_id": session,
        "tool_name": "SendMessage",
        "tool_use_id": tool_id,
        "tool_input": {
            "to": target,
            "message": message,
        },
    }
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    return value


def agent_payload(
    tool_id: str,
    description: str = "Review one bounded area",
    *,
    session: str = "parent-a",
    transcript: Path | None = None,
    agent_type: str = "general-purpose",
) -> dict:
    value = {
        "hook_event_name": "PreToolUse",
        "session_id": session,
        "tool_name": "Agent",
        "tool_use_id": tool_id,
        "tool_input": {
            "description": description,
            "prompt": "Inspect the assigned area and return findings.",
            "subagent_type": agent_type,
        },
    }
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    return value


def tool_payload(
    tool_id: str,
    tool_name: str,
    tool_input: dict,
    *,
    session: str = "session-a",
    transcript: Path | None = None,
) -> dict:
    value = {
        "hook_event_name": "PreToolUse",
        "session_id": session,
        "tool_name": tool_name,
        "tool_use_id": tool_id,
        "tool_input": tool_input,
    }
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    return value


def failure_payload(
    tool_id: str,
    tool_name: str,
    tool_input: dict,
    *,
    session: str = "session-a",
    interrupted: bool = False,
) -> dict:
    return {
        "hook_event_name": "PostToolUseFailure",
        "session_id": session,
        "tool_name": tool_name,
        "tool_use_id": tool_id,
        "tool_input": tool_input,
        "error": "representative failure",
        "is_interrupt": interrupted,
    }


def stop_failure_payload(
    message: str,
    *,
    session: str = "session-a",
    error: str = "rate_limit",
) -> dict:
    return {
        "hook_event_name": "StopFailure",
        "session_id": session,
        "error": error,
        "error_details": "429 Too Many Requests",
        "last_assistant_message": message,
    }


def research_payload(
    transcript: Path | None = None,
    *,
    session: str = "session-a",
) -> dict:
    value = {
        "hook_event_name": "UserPromptExpansion",
        "session_id": session,
        "expansion_type": "slash_command",
        "command_name": "research",
        "command_args": "investigate the project",
        "prompt": "/research investigate the project",
    }
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    return value


def stop_payload(
    agent_id: str,
    transcript: Path | None = None,
    *,
    agent_transcript: Path | None = None,
    session: str = "parent-a",
    agent_type: str = "general-purpose",
) -> dict:
    value = {
        "hook_event_name": "SubagentStop",
        "session_id": session,
        "agent_id": agent_id,
        "agent_type": agent_type,
    }
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    if agent_transcript is not None:
        value["agent_transcript_path"] = str(agent_transcript)
    return value


def start_payload(
    agent_id: str,
    *,
    session: str = "parent-a",
    agent_type: str = "general-purpose",
) -> dict:
    return {
        "hook_event_name": "SubagentStart",
        "session_id": session,
        "agent_id": agent_id,
        "agent_type": agent_type,
    }


def load_state(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def seed_known_agents(
    path: Path,
    targets: list[str],
    *,
    session: str = "parent-a",
) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 5,
                "known_agents": [
                    {
                        "at": NOW,
                        "session_id": session,
                        "target": target,
                        "agent_id": target,
                    }
                    for target in targets
                ],
            }
        ),
        encoding="utf-8",
    )


def gif_metadata(path: Path) -> tuple[int, int, int, int]:
    """Return width, height, frame count, and centiseconds for a GIF."""

    data = path.read_bytes()
    assert data[:6] in {b"GIF87a", b"GIF89a"}
    width = int.from_bytes(data[6:8], "little")
    height = int.from_bytes(data[8:10], "little")
    position = 13
    if data[10] & 0x80:
        position += 3 * (2 ** ((data[10] & 0x07) + 1))
    frames = 0
    duration = 0
    while position < len(data):
        marker = data[position]
        position += 1
        if marker == 0x3B:
            break
        if marker == 0x2C:
            frames += 1
            packed = data[position + 8]
            position += 9
            if packed & 0x80:
                position += 3 * (2 ** ((packed & 0x07) + 1))
            position += 1  # LZW minimum code size.
        elif marker == 0x21:
            label = data[position]
            position += 1
            if label == 0xF9 and data[position] == 4:
                duration += int.from_bytes(data[position + 2 : position + 4], "little")
        else:
            raise AssertionError(f"invalid GIF marker 0x{marker:02x}")
        while data[position]:
            position += data[position] + 1
        position += 1
    assert position == len(data)
    return width, height, frames, duration


def test_blocks_broad_resume_prompt() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        proc = invoke(
            "prompt",
            prompt_payload("continue and resume all agents"),
            state,
        )
        assert proc.returncode == 2
        assert "name at most four" in proc.stderr.lower()


def test_allows_negated_broad_resume_prompt() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        proc = invoke(
            "prompt",
            prompt_payload("Do not resume all agents; resume agent-a only."),
            state,
        )
        assert proc.returncode == 0


def test_unrelated_negation_does_not_bypass_broad_resume_guard() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for prompt in (
            "Do not wait; resume all agents now.",
            "Without further delay, spawn every agent.",
            "Don't hesitate — start all subagents.",
        ):
            proc = invoke("prompt", prompt_payload(prompt), state)
            assert proc.returncode == 2, prompt


def test_broad_resume_match_does_not_cross_sentence_boundary() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        proc = invoke(
            "prompt",
            prompt_payload("Continue implementation. I already reviewed every task."),
            state,
        )
        assert proc.returncode == 0


def test_allows_generic_every_task_instruction() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        proc = invoke(
            "prompt",
            prompt_payload("Start every task by reading its instructions."),
            state,
        )
        assert proc.returncode == 0


def test_override_allows_prompt_and_agent_messages() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        prompt = prompt_payload(
            "[allow-agent-burst]\nresume all agents",
            session="override-session",
        )
        assert invoke("prompt", prompt, state).returncode == 0
        assert (
            invoke(
                "prompt",
                prompt_payload("spawn every agent", session="override-session"),
                state,
            ).returncode
            == 0
        )
        for index in range(6):
            proc = invoke(
                "pre-tool",
                send_payload(
                    f"tool-{index}",
                    f"agent-{index}",
                    session="override-session",
                ),
                state,
            )
            assert proc.returncode == 0


def test_dormant_high_context_sessions_are_serialized() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        first = root / "first.jsonl"
        second = root / "second.jsonl"
        write_transcript(first, NOW - 7200, 200_000)
        write_transcript(second, NOW - 7200, 220_000)
        assert (
            invoke(
                "prompt",
                prompt_payload("continue", "session-one", first),
                state,
            ).returncode
            == 0
        )
        blocked = invoke(
            "prompt",
            prompt_payload("continue", "session-two", second),
            state,
        )
        assert blocked.returncode == 2
        assert "220,000 context tokens" in blocked.stderr


def test_fresh_or_small_session_is_not_reserved() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        fresh = root / "fresh.jsonl"
        small = root / "small.jsonl"
        large = root / "large.jsonl"
        write_transcript(fresh, NOW - 60, 300_000)
        write_transcript(small, NOW - 7200, 80_000)
        write_transcript(large, NOW - 7200, 200_000)
        assert (
            invoke(
                "prompt",
                prompt_payload("continue", "fresh", fresh),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("continue", "small", small),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("continue", "large", large),
                state,
            ).returncode
            == 0
        )


def test_allows_four_resume_messages_then_blocks() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, [f"agent-{index}" for index in range(1, 6)])
        for index in range(1, 5):
            assert (
                invoke(
                    "pre-tool",
                    send_payload(f"tool-{index}", f"agent-{index}"),
                    state,
                ).returncode
                == 0
            )
        blocked = invoke("pre-tool", send_payload("tool-5", "agent-5"), state)
        assert blocked.returncode == 2
        assert "4 agents are already active" in blocked.stderr


def test_any_message_to_inactive_agent_counts_as_resume() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for index in range(5):
            assert (
                invoke(
                    "pre-tool",
                    agent_payload(f"original-start-{index}"),
                    state,
                ).returncode
                == 0
            )
            agent_id = f"completed-agent-{index}"
            assert (
                invoke(
                    "subagent-start",
                    start_payload(agent_id),
                    state,
                ).returncode
                == 0
            )
            assert (
                invoke(
                    "subagent-stop",
                    stop_payload(agent_id),
                    state,
                ).returncode
                == 0
            )
        for index in range(4):
            assert (
                invoke(
                    "pre-tool",
                    send_payload(
                        f"follow-up-{index}",
                        f"completed-agent-{index}",
                        message="Now analyze the authorization logic.",
                    ),
                    state,
                ).returncode
                == 0
            )
        blocked = invoke(
            "pre-tool",
            send_payload(
                "follow-up-4",
                "completed-agent-4",
                message="Check the database layer too.",
            ),
            state,
        )
        assert blocked.returncode == 2
        assert "4 agents are already active" in blocked.stderr


def test_unknown_agent_coordination_messages_do_not_consume_resume_budget() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for index in range(8):
            proc = invoke(
                "pre-tool",
                send_payload(
                    f"team-message-{index}",
                    f"teammate-{index}",
                    message="Please send your current findings.",
                ),
                state,
            )
            assert proc.returncode == 0
        assert load_state(state)["agent_history"] == []


def test_resume_by_name_binds_agent_id_and_remains_known_after_lease_ttl() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        alias = "code-reviewer"
        agent_id = "agent-id-from-lifecycle"

        assert (
            invoke(
                "pre-tool",
                agent_payload("fresh-by-name", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload(agent_id, agent_type=alias),
                state,
                now=NOW + 1,
            ).returncode
            == 0
        )
        lease = load_state(state)["agent_leases"][0]
        assert lease["target"] == alias
        assert lease["agent_id"] == agent_id

        assert (
            invoke(
                "subagent-stop",
                stop_payload(agent_id, agent_type=alias),
                state,
                now=NOW + 2,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert guard_state["agent_leases"] == []
        assert {
            item["target"]
            for item in guard_state["known_agents"]
            if item["session_id"] == "parent-a"
        } >= {alias, agent_id}

        # Claude retains resumable subagent transcripts for 30 days by default.
        # The registry must therefore outlive the six-hour active-lease TTL.
        follow_up = invoke(
            "pre-tool",
            send_payload(
                "late-follow-up",
                alias,
                message="Now inspect the authorization layer.",
            ),
            state,
            now=NOW + 7 * 60 * 60,
        )
        assert follow_up.returncode == 0
        assert load_state(state)["agent_pending"][0]["target"] == alias


def test_concurrent_named_resume_binds_before_unrelated_start() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        alias = "code-reviewer"
        seed_known_agents(state, [alias])
        assert (
            invoke(
                "pre-tool",
                agent_payload(
                    "fresh-start",
                    agent_type="general-purpose",
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                send_payload("named-resume", alias),
                state,
            ).returncode
            == 0
        )

        # The resumed lifecycle may arrive before the unrelated fresh start.
        assert (
            invoke(
                "subagent-start",
                start_payload("resumed-id", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload("resumed-id", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        pending = load_state(state)["agent_pending"]
        assert len(pending) == 1
        assert pending[0]["tool_use_id"] == "fresh-start"

        assert (
            invoke(
                "tool-failure",
                failure_payload(
                    "fresh-start",
                    "Agent",
                    agent_payload("unused")["tool_input"],
                    session="parent-a",
                ),
                state,
            ).returncode
            == 0
        )
        assert load_state(state)["agent_pending"] == []


def test_agent_starts_share_the_same_four_slots() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert invoke("pre-tool", agent_payload("start-1"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-2"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-3"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-4"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-5"), state).returncode == 2


def test_subagent_stop_releases_start_and_resume_slots() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(
            state,
            ["agent-existing", "agent-filler", "agent-next"],
        )
        assert invoke("pre-tool", agent_payload("start-1"), state).returncode == 0
        assert (
            invoke(
                "pre-tool", send_payload("resume-1", "agent-existing"), state
            ).returncode
            == 0
        )
        assert invoke("pre-tool", agent_payload("start-1b"), state).returncode == 0
        assert (
            invoke(
                "pre-tool", send_payload("resume-filler", "agent-filler"), state
            ).returncode
            == 0
        )
        assert invoke("pre-tool", agent_payload("start-blocked"), state).returncode == 2

        # A resumed agent confirms before its stop releases the active lease.
        assert (
            invoke(
                "subagent-start",
                start_payload("agent-existing", agent_type="agent-existing"),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke("subagent-stop", stop_payload("agent-existing"), state).returncode
            == 0
        )
        assert invoke("pre-tool", agent_payload("start-2"), state).returncode == 0

        # A newly-created agent gets its id at SubagentStart, which binds the
        # anonymous PreToolUse reservation before SubagentStop releases it.
        assert (
            invoke("subagent-start", start_payload("new-agent-id"), state).returncode
            == 0
        )
        assert (
            invoke("subagent-stop", stop_payload("new-agent-id"), state).returncode == 0
        )
        assert (
            invoke("pre-tool", send_payload("resume-2", "agent-next"), state).returncode
            == 0
        )


def test_duplicate_global_and_project_lifecycle_hooks_are_idempotent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert invoke("pre-tool", agent_payload("start-1"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-2"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-3"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-4"), state).returncode == 0

        started = start_payload("agent-new")
        assert invoke("subagent-start", started, state).returncode == 0
        assert invoke("subagent-start", started, state).returncode == 0

        stopped = stop_payload("agent-new")
        assert invoke("subagent-stop", stopped, state).returncode == 0
        assert invoke("subagent-stop", stopped, state).returncode == 0

        # Exactly one slot was released by the duplicated stop delivery.
        assert invoke("pre-tool", agent_payload("start-5"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("start-6"), state).returncode == 2


def test_same_type_stop_releases_the_exact_agent_id() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert invoke("pre-tool", agent_payload("first"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("second"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-a"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-b"), state).returncode == 0
        assert invoke("subagent-stop", stop_payload("agent-b"), state).returncode == 0
        leases = load_state(state)["agent_leases"]
        assert len(leases) == 1
        assert leases[0]["agent_id"] == "agent-a"


def test_out_of_order_same_type_named_starts_never_swap_reservations() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"

        def named(tool_id: str, name: str) -> dict:
            return tool_payload(
                tool_id,
                "Agent",
                {
                    "description": f"agent {name}",
                    "prompt": "inspect",
                    "subagent_type": "general-purpose",
                    "name": name,
                },
                session="parent-a",
            )

        alpha = named("start-alpha", "alpha")
        beta = named("start-beta", "beta")
        assert invoke("pre-tool", alpha, state).returncode == 0
        assert invoke("pre-tool", beta, state).returncode == 0
        assert (
            invoke("subagent-start", start_payload("agent-beta"), state).returncode == 0
        )
        assert (
            invoke("subagent-start", start_payload("agent-alpha"), state).returncode
            == 0
        )
        mid = load_state(state)
        assert {item["tool_use_id"] for item in mid["agent_pending"]} == {
            "start-alpha",
            "start-beta",
        }
        assert all(
            item["source"] == "observed_unreserved" for item in mid["agent_leases"]
        )
        for attempted in (beta, alpha):
            post = dict(attempted)
            post["hook_event_name"] = "PostToolUse"
            post["tool_response"] = {"status": "completed"}
            assert invoke("post-tool", post, state).returncode == 0
        assert (
            invoke("subagent-stop", stop_payload("agent-alpha"), state).returncode == 0
        )
        gamma = agent_payload("post-correlation-gamma")
        assert invoke("pre-tool", gamma, state).returncode == 0
        assert (
            invoke(
                "pre-tool",
                agent_payload("post-correlation-delta"),
                state,
                extra_env={"AGENT_GUARD_AGENT_MAX": "2"},
            ).returncode
            == 2
        )
        assert (
            invoke(
                "tool-failure",
                failure_payload(
                    "post-correlation-gamma",
                    "Agent",
                    gamma["tool_input"],
                    session="parent-a",
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke("subagent-stop", stop_payload("agent-beta"), state).returncode == 0
        )
        after = load_state(state)
        assert after["agent_pending"] == []
        assert after["agent_leases"] == []
        assert len(after["agent_history"]) == 2
        assert (
            invoke(
                "pre-tool",
                send_payload(
                    "resume-alpha",
                    "alpha",
                    message="Now inspect authorization.",
                ),
                state,
            ).returncode
            == 0
        )
        assert {item["tool_use_id"] for item in load_state(state)["agent_pending"]} == {
            "resume-alpha"
        }


def test_ambiguous_start_and_remaining_pending_share_one_capacity_slot() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"

        def named(tool_id: str, name: str) -> dict:
            return tool_payload(
                tool_id,
                "Agent",
                {
                    "description": name,
                    "prompt": "inspect",
                    "subagent_type": "general-purpose",
                    "name": name,
                },
                session="parent-a",
            )

        alpha = named("alpha-attempt", "alpha")
        beta = named("beta-attempt", "beta")
        assert invoke("pre-tool", alpha, state).returncode == 0
        assert invoke("pre-tool", beta, state).returncode == 0
        assert (
            invoke("subagent-start", start_payload("actual-beta"), state).returncode
            == 0
        )
        assert (
            invoke(
                "tool-failure",
                failure_payload(
                    "alpha-attempt",
                    "Agent",
                    alpha["tool_input"],
                    session="parent-a",
                ),
                state,
            ).returncode
            == 0
        )
        assert invoke("pre-tool", agent_payload("gamma"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("delta"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("epsilon"), state).returncode == 0
        blocked = invoke("pre-tool", agent_payload("zeta"), state)
        assert blocked.returncode == 2
        assert "already active or reserved" in blocked.stderr


def test_expired_ambiguous_candidates_never_overlap_a_future_pending_attempt() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"

        def named(tool_id: str, name: str) -> dict:
            return tool_payload(
                tool_id,
                "Agent",
                {
                    "description": name,
                    "prompt": "inspect",
                    "subagent_type": "general-purpose",
                    "name": name,
                },
                session="parent-a",
            )

        assert invoke("pre-tool", named("alpha-old", "alpha"), state).returncode == 0
        assert invoke("pre-tool", named("beta-old", "beta"), state).returncode == 0
        assert (
            invoke(
                "subagent-start",
                start_payload("ambiguous-running"),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                named("gamma-new", "gamma"),
                state,
                now=NOW + 301,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                named("delta-new", "delta"),
                state,
                now=NOW + 301,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                named("epsilon-new", "epsilon"),
                state,
                now=NOW + 301,
            ).returncode
            == 0
        )
        blocked = invoke(
            "pre-tool",
            named("zeta-new", "zeta"),
            state,
            now=NOW + 301,
        )
        assert blocked.returncode == 2
        assert "already active or reserved" in blocked.stderr


def test_duplicate_stop_does_not_release_another_same_type_agent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert invoke("pre-tool", agent_payload("first"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("second"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("third"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("fourth"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-a"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-b"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-c"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-d"), state).returncode == 0
        stopped = stop_payload("agent-a")
        assert invoke("subagent-stop", stopped, state).returncode == 0
        assert invoke("subagent-stop", stopped, state).returncode == 0
        leases = load_state(state)["agent_leases"]
        assert len(leases) == 3
        assert {lease["agent_id"] for lease in leases} == {
            "agent-b",
            "agent-c",
            "agent-d",
        }
        assert invoke("pre-tool", agent_payload("fifth"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("sixth"), state).returncode == 2


def test_same_tool_retry_is_idempotent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        payload = send_payload("same-tool", "agent-1")
        assert invoke("pre-tool", payload, state).returncode == 0
        assert invoke("pre-tool", payload, state).returncode == 0


def test_normal_agent_coordination_is_not_rate_limited() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for index in range(2):
            assert (
                invoke(
                    "pre-tool",
                    agent_payload(f"start-{index}"),
                    state,
                ).returncode
                == 0
            )
            assert (
                invoke(
                    "subagent-start",
                    start_payload(f"agent-{index}"),
                    state,
                ).returncode
                == 0
            )
        for index in range(8):
            payload = send_payload(
                f"tool-{index}",
                f"agent-{index % 2}",
                message="Please send your current findings.",
            )
            assert invoke("pre-tool", payload, state).returncode == 0


def test_window_expiry_allows_next_batch() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(
            state,
            ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"],
        )
        assert invoke("pre-tool", send_payload("a", "agent-a"), state).returncode == 0
        assert invoke("pre-tool", send_payload("b", "agent-b"), state).returncode == 0
        assert invoke("pre-tool", send_payload("c", "agent-c"), state).returncode == 0
        assert invoke("pre-tool", send_payload("d", "agent-d"), state).returncode == 0
        assert invoke("pre-tool", send_payload("e", "agent-e"), state).returncode == 2
        assert invoke("subagent-start", start_payload("agent-a"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-b"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-c"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-d"), state).returncode == 0
        assert invoke("subagent-stop", stop_payload("agent-a"), state).returncode == 0
        assert invoke("subagent-stop", stop_payload("agent-b"), state).returncode == 0
        assert invoke("subagent-stop", stop_payload("agent-c"), state).returncode == 0
        assert invoke("subagent-stop", stop_payload("agent-d"), state).returncode == 0
        assert (
            invoke(
                "pre-tool",
                send_payload("f", "agent-f"),
                state,
                now=NOW + 601,
            ).returncode
            == 0
        )


def test_short_window_process_cannot_erase_another_process_history() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        long_window = {"AGENT_GUARD_WINDOW_SECONDS": "600"}
        for index in range(12):
            assert (
                invoke(
                    "pre-tool",
                    agent_payload(f"long-{index}", session="long-session"),
                    state,
                    extra_env=long_window,
                ).returncode
                == 0
            )
            agent_id = f"long-agent-{index}"
            assert (
                invoke(
                    "subagent-start",
                    start_payload(agent_id, session="long-session"),
                    state,
                    extra_env=long_window,
                ).returncode
                == 0
            )
            assert (
                invoke(
                    "subagent-stop",
                    stop_payload(agent_id, session="long-session"),
                    state,
                    extra_env=long_window,
                ).returncode
                == 0
            )
        assert len(load_state(state)["agent_history"]) == 12
        assert (
            invoke(
                "prompt",
                prompt_payload("/status", session="short-session"),
                state,
                now=NOW + 100,
                extra_env={"AGENT_GUARD_WINDOW_SECONDS": "1"},
            ).returncode
            == 0
        )
        assert len(load_state(state)["agent_history"]) == 12
        blocked = invoke(
            "pre-tool",
            agent_payload("thirteenth", session="long-session"),
            state,
            now=NOW + 100,
            extra_env=long_window,
        )
        assert blocked.returncode == 2
        assert "rolling agent guard" in blocked.stderr
        assert (
            invoke(
                "prompt",
                prompt_payload("/status", session="short-session"),
                state,
                now=NOW + 601,
                extra_env={"AGENT_GUARD_WINDOW_SECONDS": "1"},
            ).returncode
            == 0
        )
        assert len(load_state(state)["agent_history"]) == 12
        assert (
            invoke(
                "prompt",
                prompt_payload("/status", session="short-session"),
                state,
                now=NOW + 24 * 60 * 60 + 1,
                extra_env={"AGENT_GUARD_WINDOW_SECONDS": "1"},
            ).returncode
            == 0
        )
        assert load_state(state)["agent_history"] == []


def test_short_window_origin_cannot_hide_history_from_long_window_caller() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        short_window = {"AGENT_GUARD_WINDOW_SECONDS": "1"}
        for index in range(12):
            tool_id = f"short-{index}"
            agent_id = f"short-agent-{index}"
            assert (
                invoke(
                    "pre-tool",
                    agent_payload(tool_id, session="mixed-session"),
                    state,
                    extra_env=short_window,
                ).returncode
                == 0
            )
            assert (
                invoke(
                    "subagent-start",
                    start_payload(agent_id, session="mixed-session"),
                    state,
                    extra_env=short_window,
                ).returncode
                == 0
            )
            assert (
                invoke(
                    "subagent-stop",
                    stop_payload(agent_id, session="mixed-session"),
                    state,
                    extra_env=short_window,
                ).returncode
                == 0
            )
        blocked = invoke(
            "pre-tool",
            agent_payload("long-window-thirteenth", session="mixed-session"),
            state,
            now=NOW + 2,
            extra_env={"AGENT_GUARD_WINDOW_SECONDS": "600"},
        )
        assert blocked.returncode == 2
        assert "rolling agent guard" in blocked.stderr


def test_active_agents_remain_leased_after_rolling_window_expires() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(
            state,
            ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"],
        )
        assert invoke("pre-tool", send_payload("a", "agent-a"), state).returncode == 0
        assert invoke("pre-tool", send_payload("b", "agent-b"), state).returncode == 0
        assert invoke("pre-tool", send_payload("c", "agent-c"), state).returncode == 0
        assert invoke("pre-tool", send_payload("d", "agent-d"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-a"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-b"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-c"), state).returncode == 0
        assert invoke("subagent-start", start_payload("agent-d"), state).returncode == 0
        blocked = invoke(
            "pre-tool",
            send_payload("e", "agent-e"),
            state,
            now=NOW + 601,
        )
        assert blocked.returncode == 2
        assert "already active" in blocked.stderr
        assert (
            invoke(
                "subagent-stop",
                stop_payload("agent-a"),
                state,
                now=NOW + 601,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                send_payload("f", "agent-f"),
                state,
                now=NOW + 601,
            ).returncode
            == 0
        )


def test_nondefault_lease_expiry_is_stamped_per_confirmed_agent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        long_state = Path(tmp) / "long-state.json"
        long_env = {
            "AGENT_GUARD_AGENT_MAX": "1",
            "AGENT_GUARD_LEASE_SECONDS": "30000",
        }
        assert (
            invoke(
                "pre-tool",
                agent_payload("long-lease"),
                long_state,
                extra_env=long_env,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload("long-agent"),
                long_state,
                extra_env=long_env,
            ).returncode
            == 0
        )
        still_blocked = invoke(
            "pre-tool",
            agent_payload("too-soon"),
            long_state,
            now=NOW + 7 * 60 * 60,
            extra_env={"AGENT_GUARD_AGENT_MAX": "1"},
        )
        assert still_blocked.returncode == 2

        short_state = Path(tmp) / "short-state.json"
        short_env = {
            "AGENT_GUARD_AGENT_MAX": "1",
            "AGENT_GUARD_LEASE_SECONDS": "10",
        }
        assert (
            invoke(
                "pre-tool",
                agent_payload("short-lease"),
                short_state,
                extra_env=short_env,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload("short-agent"),
                short_state,
                extra_env=short_env,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("after-short-expiry"),
                short_state,
                now=NOW + 11,
                extra_env={"AGENT_GUARD_AGENT_MAX": "1"},
            ).returncode
            == 0
        )


def test_nondefault_known_agent_expiry_is_stamped_per_alias() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        env = {"AGENT_GUARD_KNOWN_AGENT_SECONDS": "10"}
        assert (
            invoke(
                "pre-tool",
                agent_payload("known-short", agent_type="reviewer"),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload("known-id", agent_type="reviewer"),
                state,
                extra_env=env,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload("known-id", agent_type="reviewer"),
                state,
                extra_env=env,
            ).returncode
            == 0
        )
        unknown_again = send_payload(
            "after-known-expiry",
            "reviewer",
            message="Resume where you left off.",
        )
        assert (
            invoke(
                "pre-tool",
                unknown_again,
                state,
                now=NOW + 11,
            ).returncode
            == 0
        )
        assert load_state(state)["agent_pending"] == []


def test_parallel_resumes_atomically_allow_only_four() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, [f"agent-{index}" for index in range(8)])

        def one(index: int) -> int:
            return invoke(
                "pre-tool",
                send_payload(f"parallel-{index}", f"agent-{index}"),
                state,
            ).returncode

        with ThreadPoolExecutor(max_workers=8) as pool:
            codes = list(pool.map(one, range(8)))
        assert codes.count(0) == 4, codes
        assert codes.count(2) == 4, codes


def test_parallel_agent_starts_atomically_allow_only_four() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"

        def one(index: int) -> int:
            return invoke(
                "pre-tool",
                agent_payload(f"parallel-start-{index}"),
                state,
            ).returncode

        with ThreadPoolExecutor(max_workers=8) as pool:
            codes = list(pool.map(one, range(8)))
        assert codes.count(0) == 4, codes
        assert codes.count(2) == 4, codes


def test_rate_limit_circuit_blocks_work_but_allows_recovery_and_expires() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        observed = invoke(
            "stop-failure",
            stop_failure_payload("You've hit your session limit · resets in 5 minutes"),
            state,
        )
        assert observed.returncode == 0

        blocked_prompt = invoke(
            "prompt",
            prompt_payload("continue implementing the feature"),
            state,
        )
        assert blocked_prompt.returncode == 2
        assert "circuit breaker" in blocked_prompt.stderr
        blocked_agent = invoke(
            "pre-tool",
            agent_payload("rate-limited-agent"),
            state,
        )
        assert blocked_agent.returncode == 2
        assert "circuit breaker" in blocked_agent.stderr

        assert invoke("prompt", prompt_payload("/status"), state).returncode == 0
        assert (
            invoke(
                "pre-tool",
                tool_payload("read-during-lock", "Read", {"file_path": "README.md"}),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("continue implementing", session="session-a"),
                state,
                now=NOW + 301,
            ).returncode
            == 0
        )


def test_billing_error_activates_spend_circuit_breaker() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        observed = invoke(
            "stop-failure",
            stop_failure_payload(
                "API Error: monthly spend limit reached",
                error="billing_error",
            ),
            state,
        )
        assert observed.returncode == 0
        blocked = invoke(
            "prompt",
            prompt_payload("keep working"),
            state,
        )
        assert blocked.returncode == 2
        assert "spend limit is active" in blocked.stderr


def test_usage_override_bypasses_active_rate_limit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        invoke(
            "stop-failure",
            stop_failure_payload("API Error: Rate limit reached"),
            state,
        )
        assert (
            invoke(
                "prompt",
                prompt_payload(
                    "[allow-usage-guard]\ncontinue",
                    session="override-usage",
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("override-agent", session="override-usage"),
                state,
            ).returncode
            == 0
        )


def test_session_reset_clock_is_parsed_into_future_lock() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        invoke(
            "stop-failure",
            stop_failure_payload(
                "You've hit your session limit · resets 3:10am (Europe/London)"
            ),
            state,
        )
        lock = load_state(state)["rate_limit"]
        assert lock["category"] == "session"
        assert NOW < lock["until"] <= NOW + 24 * 60 * 60


def test_reset_clock_without_zone_uses_users_local_timezone() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        env = {"TZ": "America/Los_Angeles"}
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload("Session limit reached; resets at 9pm"),
                state,
                extra_env=env,
            ).returncode
            == 0
        )
        expected = datetime(
            2033,
            5,
            17,
            21,
            0,
            tzinfo=ZoneInfo("America/Los_Angeles"),
        ).timestamp()
        assert load_state(state)["rate_limit"]["until"] == expected
        blocked = invoke(
            "prompt",
            prompt_payload("continue"),
            state,
            extra_env=env,
        )
        assert blocked.returncode == 2
        assert "9:00PM PDT on 17 May" in blocked.stderr


def test_compound_relative_reset_preserves_full_cooldown() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        invoke(
            "stop-failure",
            stop_failure_payload("Session limit; resets in 2 hours 15 minutes"),
            state,
        )
        lock = load_state(state)["rate_limit"]
        assert lock["until"] == NOW + 2 * 60 * 60 + 15 * 60


def test_rolling_agent_budget_survives_agent_completion() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for index in range(12):
            assert (
                invoke(
                    "pre-tool",
                    agent_payload(f"rolling-{index}"),
                    state,
                ).returncode
                == 0
            )
            agent_id = f"agent-{index}"
            assert (
                invoke("subagent-start", start_payload(agent_id), state).returncode == 0
            )
            assert (
                invoke("subagent-stop", stop_payload(agent_id), state).returncode == 0
            )
        blocked = invoke("pre-tool", agent_payload("rolling-12"), state)
        assert blocked.returncode == 2
        assert "12 starts/resumes" in blocked.stderr


def test_nested_agent_spawn_is_blocked_but_normal_leaf_tools_work() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        nested_dir = root / "session" / "subagents"
        nested_dir.mkdir(parents=True)
        transcript = nested_dir / "agent-child.jsonl"
        write_transcript(transcript, NOW - 1, 20_000)

        normal = invoke(
            "pre-tool",
            tool_payload(
                "nested-read",
                "Read",
                {"file_path": "README.md"},
                session="parent-a",
                transcript=transcript,
            ),
            state,
        )
        assert normal.returncode == 0
        blocked = invoke(
            "pre-tool",
            agent_payload(
                "nested-agent",
                session="parent-a",
                transcript=transcript,
            ),
            state,
        )
        assert blocked.returncode == 2
        assert "subagent may not spawn" in blocked.stderr


def test_agent_override_allows_intentional_nested_agent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        nested_dir = root / "session" / "subagents"
        nested_dir.mkdir(parents=True)
        transcript = nested_dir / "agent-child.jsonl"
        write_transcript(transcript, NOW - 1, 20_000)
        assert (
            invoke(
                "prompt",
                prompt_payload(
                    "[allow-agent-burst]\nAllow one nested agent",
                    session="parent-a",
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload(
                    "nested-override",
                    session="parent-a",
                    transcript=transcript,
                ),
                state,
            ).returncode
            == 0
        )


def test_agent_context_ceiling_blocks_next_start() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        nested_dir = root / "session" / "subagents"
        nested_dir.mkdir(parents=True)
        transcript = nested_dir / "agent-heavy.jsonl"
        write_transcript(transcript, NOW - 1, 20_000_000)
        assert (
            invoke(
                "pre-tool",
                tool_payload(
                    "heavy-read",
                    "Read",
                    {"file_path": "README.md"},
                    session="parent-a",
                    transcript=transcript,
                ),
                state,
                extra_env={"AGENT_GUARD_TOOL_MAX": "100"},
            ).returncode
            == 0
        )
        blocked = invoke("pre-tool", agent_payload("after-heavy-agent"), state)
        assert blocked.returncode == 2
        assert "20,000,000 raw context tokens" in blocked.stderr


def test_subagent_stop_counts_all_requests_from_agent_transcript() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        parent = root / "parent.jsonl"
        agent_dir = root / "subagents"
        agent_dir.mkdir()
        agent = agent_dir / "agent-a.jsonl"
        write_transcript(parent, NOW - 1, 1_000)
        write_transcript(
            agent,
            NOW - 1,
            60,
            request_id="agent-request-2",
            extra_records=[
                assistant_record(
                    NOW - 2,
                    60,
                    request_id="agent-request-1",
                )
            ],
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload(
                    "agent-a",
                    transcript=parent,
                    agent_transcript=agent,
                ),
                state,
            ).returncode
            == 0
        )
        usage = load_state(state)["usage_events"]
        assert {item["id"] for item in usage} == {
            "agent-request-1",
            "agent-request-2",
        }
        assert all(item["subagent"] for item in usage)
        blocked = invoke(
            "pre-tool",
            agent_payload("after-agent-context"),
            state,
            extra_env={"AGENT_GUARD_CONTEXT_MAX": "100"},
        )
        assert blocked.returncode == 2
        assert "120 raw context tokens" in blocked.stderr


def test_context_warning_hard_gate_recovery_override_and_postcompact() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        warning_state = root / "warning-state.json"
        warning_transcript = root / "warning.jsonl"
        write_transcript(warning_transcript, NOW - 1, 350_000)
        warning = invoke(
            "prompt",
            prompt_payload("continue", "warning", warning_transcript),
            warning_state,
        )
        assert warning.returncode == 0
        assert "USAGE GUARD" in warning.stdout
        # Duplicate global/project delivery does not duplicate injected context.
        duplicate = invoke(
            "prompt",
            prompt_payload("continue", "warning", warning_transcript),
            warning_state,
        )
        assert duplicate.returncode == 0
        assert duplicate.stdout == ""

        hard_state = root / "hard-state.json"
        hard_transcript = root / "hard.jsonl"
        write_transcript(hard_transcript, NOW - 1, 600_000)
        blocked = invoke(
            "prompt",
            prompt_payload("continue", "hard", hard_transcript),
            hard_state,
        )
        assert blocked.returncode == 2
        assert "run /compact or /clear" in blocked.stderr.lower()
        assert (
            invoke(
                "prompt",
                prompt_payload("/compact", "hard", hard_transcript),
                hard_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "post-compact",
                {
                    "hook_event_name": "PostCompact",
                    "session_id": "hard",
                    "transcript_path": str(hard_transcript),
                },
                hard_state,
            ).returncode
            == 0
        )
        # The transcript can lag PostCompact; the recorded boundary prevents
        # the stale 600k request from immediately re-blocking the session.
        assert (
            invoke(
                "prompt",
                prompt_payload("new bounded task", "hard", hard_transcript),
                hard_state,
            ).returncode
            == 0
        )

        override_state = root / "override-state.json"
        assert (
            invoke(
                "prompt",
                prompt_payload(
                    "[allow-usage-guard]\ncontinue",
                    "hard-override",
                    hard_transcript,
                ),
                override_state,
            ).returncode
            == 0
        )


def test_default_context_hard_limit_boundary() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        below = root / "below.jsonl"
        at_limit = root / "at-limit.jsonl"
        write_transcript(below, NOW - 1, 499_999)
        write_transcript(at_limit, NOW - 1, 500_000)

        allowed = invoke(
            "prompt",
            prompt_payload("Continue bounded work.", "below-limit", below),
            state,
        )
        assert allowed.returncode == 0
        blocked = invoke(
            "prompt",
            prompt_payload("Continue bounded work.", "at-limit", at_limit),
            state,
        )
        assert blocked.returncode == 2
        assert "500,000 context tokens" in blocked.stderr


def test_postcompact_fallback_ignores_precompact_usage_without_transcript() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "hard.jsonl"
        write_transcript(transcript, NOW - 1, 600_000)
        assert (
            invoke(
                "prompt",
                prompt_payload("continue", "hard", transcript),
                state,
            ).returncode
            == 2
        )
        assert (
            invoke(
                "post-compact",
                {
                    "hook_event_name": "PostCompact",
                    "session_id": "hard",
                    "transcript_path": str(transcript),
                },
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("bounded task", "hard"),
                state,
            ).returncode
            == 0
        )


def test_high_context_turn_stops_after_tool_budget() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "high-context.jsonl"
        write_transcript(transcript, NOW - 1, 450_000)
        env = {"AGENT_GUARD_TOOL_MAX": "2"}
        for index in range(2):
            assert (
                invoke(
                    "pre-tool",
                    tool_payload(
                        f"high-{index}",
                        "Bash",
                        {"command": f"echo {index}"},
                        transcript=transcript,
                    ),
                    state,
                    extra_env=env,
                ).returncode
                == 0
            )
        blocked = invoke(
            "pre-tool",
            tool_payload(
                "high-2",
                "Bash",
                {"command": "echo 2"},
                transcript=transcript,
            ),
            state,
            extra_env=env,
        )
        assert blocked.returncode == 2
        assert "high-context turn guard" in blocked.stderr


def test_research_expansion_is_bounded_and_duplicate_notice_is_suppressed() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "research.jsonl"
        write_transcript(transcript, NOW - 1, 100_000)
        first = invoke(
            "prompt-expansion",
            research_payload(transcript),
            state,
        )
        assert first.returncode == 0
        assert "at most 12 total leaf agents" in first.stdout
        duplicate = invoke(
            "prompt-expansion",
            research_payload(transcript),
            state,
        )
        assert duplicate.returncode == 0
        assert duplicate.stdout == ""
        configured = invoke(
            "prompt-expansion",
            research_payload(transcript, session="configured"),
            root / "configured-state.json",
            extra_env={
                "AGENT_GUARD_ROLLING_MAX": "8",
                "AGENT_GUARD_AGENT_MAX": "3",
                "AGENT_GUARD_WINDOW_SECONDS": "900",
            },
        )
        assert "at most 8 total leaf agents in 15 minutes" in configured.stdout
        assert "at most 3 concurrently" in configured.stdout


def test_research_expansion_blocks_high_context_and_recent_max_effort() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        high_state = root / "high-state.json"
        high = root / "research-high.jsonl"
        write_transcript(high, NOW - 1, 300_000)
        blocked_high = invoke(
            "prompt-expansion",
            research_payload(high),
            high_state,
        )
        assert blocked_high.returncode == 2
        assert "/compact first" in blocked_high.stderr

        effort_state = root / "effort-state.json"
        effort = root / "research-effort.jsonl"
        write_transcript(
            effort,
            NOW - 1,
            100_000,
            extra_records=[
                user_record(NOW - 30, "<local-command-stdout>Set effort level to max")
            ],
        )
        blocked_effort = invoke(
            "prompt-expansion",
            research_payload(effort),
            effort_state,
        )
        assert blocked_effort.returncode == 2
        assert "maximum effort" in blocked_effort.stderr


def test_research_uses_most_recent_effort_change() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "research-effort-lowered.jsonl"
        write_transcript(
            transcript,
            NOW - 1,
            100_000,
            extra_records=[
                user_record(NOW - 60, "<local-command-stdout>Set effort level to max"),
                user_record(
                    NOW - 30,
                    "<local-command-stdout>Set effort level to medium",
                ),
            ],
        )
        allowed = invoke(
            "prompt-expansion",
            research_payload(transcript),
            state,
        )
        assert allowed.returncode == 0
        assert "at most 12 total leaf agents" in allowed.stdout


def test_research_honors_current_xhigh_effort_payload_and_transcript_shape() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        payload_state = root / "payload-state.json"
        current = research_payload()
        current["effort"] = {"level": "xhigh"}
        blocked_payload = invoke("prompt-expansion", current, payload_state)
        assert blocked_payload.returncode == 2
        assert "maximum effort" in blocked_payload.stderr

        transcript_state = root / "transcript-state.json"
        transcript = root / "xhigh.jsonl"
        record = assistant_record(NOW - 1, 20_000, "xhigh-request")
        record["effort"] = "xhigh"
        transcript.write_text(json.dumps(record) + "\n", encoding="utf-8")
        blocked_transcript = invoke(
            "prompt-expansion",
            research_payload(transcript),
            transcript_state,
        )
        assert blocked_transcript.returncode == 2
        assert "maximum effort" in blocked_transcript.stderr


def test_current_lower_effort_payload_overrides_old_xhigh_transcript() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "old-xhigh.jsonl"
        record = assistant_record(NOW - 1, 20_000, "old-xhigh")
        record["effort"] = "xhigh"
        transcript.write_text(json.dumps(record) + "\n", encoding="utf-8")
        payload = research_payload(transcript)
        payload["effort"] = {"level": "high"}
        assert invoke("prompt-expansion", payload, state).returncode == 0


def test_research_expansion_blocks_when_rolling_agent_budget_is_near_limit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for index in range(10):
            assert (
                invoke("pre-tool", agent_payload(f"near-{index}"), state).returncode
                == 0
            )
            agent_id = f"near-agent-{index}"
            invoke("subagent-start", start_payload(agent_id), state)
            invoke("subagent-stop", stop_payload(agent_id), state)
        blocked = invoke("prompt-expansion", research_payload(), state)
        assert blocked.returncode == 2
        assert "rolling agent budget" in blocked.stderr


def test_identical_tool_failure_fuse_warns_blocks_and_expires() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        tool_input = {
            "query": "private query that must not be persisted",
            "token": "super-secret",
        }
        for index in range(2):
            proc = invoke(
                "tool-failure",
                failure_payload(f"failure-{index}", "mcp__search", tool_input),
                state,
            )
            assert proc.returncode == 0
            assert proc.stdout == ""
        third = invoke(
            "tool-failure",
            failure_payload("failure-2", "mcp__search", tool_input),
            state,
        )
        assert third.returncode == 0
        assert "retry fuse is now active" in third.stdout

        blocked = invoke(
            "pre-tool",
            tool_payload("fourth-attempt", "mcp__search", tool_input),
            state,
        )
        assert blocked.returncode == 2
        assert "failed 3 times" in blocked.stderr
        assert (
            invoke(
                "pre-tool",
                tool_payload(
                    "changed-attempt",
                    "mcp__search",
                    {**tool_input, "query": "changed query"},
                ),
                state,
            ).returncode
            == 0
        )
        serialized = state.read_text(encoding="utf-8")
        assert "private query" not in serialized
        assert "super-secret" not in serialized
        assert (
            invoke(
                "pre-tool",
                tool_payload("after-expiry", "mcp__search", tool_input),
                state,
                now=NOW + 601,
            ).returncode
            == 0
        )


def test_duplicate_and_interrupted_tool_failures_are_not_counted_twice() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        value = {"command": "false"}
        same = failure_payload("same-failure", "Bash", value)
        assert invoke("tool-failure", same, state).returncode == 0
        assert invoke("tool-failure", same, state).returncode == 0
        assert (
            invoke(
                "tool-failure",
                failure_payload(
                    "interrupted",
                    "Bash",
                    value,
                    interrupted=True,
                ),
                state,
            ).returncode
            == 0
        )
        failures = load_state(state)["tool_failures"]
        assert len(failures) == 1


def test_failed_agent_launch_releases_slot_without_confirmed_history() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        attempted = agent_payload("failed-agent")
        assert invoke("pre-tool", attempted, state).returncode == 0
        failure = failure_payload(
            "failed-agent",
            "Agent",
            attempted["tool_input"],
            session="parent-a",
        )
        assert invoke("tool-failure", failure, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_leases"] == []
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_history"] == []
        assert invoke("pre-tool", agent_payload("next-1"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("next-2"), state).returncode == 0


def test_interrupted_agent_launch_releases_slot_without_failure_count() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        attempted = agent_payload("interrupted-agent")
        assert invoke("pre-tool", attempted, state).returncode == 0
        interrupted = failure_payload(
            "interrupted-agent",
            "Agent",
            attempted["tool_input"],
            session="parent-a",
            interrupted=True,
        )
        assert invoke("tool-failure", interrupted, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_leases"] == []
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_history"] == []
        assert guard_state["tool_failures"] == []


def test_permission_denied_agent_launch_releases_reserved_slot() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        attempted = agent_payload("denied-agent")
        assert invoke("pre-tool", attempted, state).returncode == 0
        denied = dict(attempted)
        denied["hook_event_name"] = "PermissionDenied"
        assert invoke("permission-denied", denied, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_leases"] == []
        assert guard_state["agent_history"] == []
        assert guard_state["tool_events"] == []


def test_permission_denied_ordinary_tool_does_not_consume_tool_budget() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        attempted = tool_payload(
            "denied-read",
            "Read",
            {"file_path": "README.md"},
        )
        assert invoke("pre-tool", attempted, state).returncode == 0
        assert len(load_state(state)["tool_events"]) == 1
        denied = dict(attempted)
        denied["hook_event_name"] = "PermissionDenied"
        assert invoke("permission-denied", denied, state).returncode == 0
        assert load_state(state)["tool_events"] == []


def test_tool_failure_fuse_is_scoped_to_one_session() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        tool_input = {"query": "same input in two sessions"}
        for index in range(3):
            invoke(
                "tool-failure",
                failure_payload(
                    f"a-{index}",
                    "mcp__search",
                    tool_input,
                    session="session-a",
                ),
                state,
            )
        assert (
            invoke(
                "pre-tool",
                tool_payload(
                    "session-b-attempt",
                    "mcp__search",
                    tool_input,
                    session="session-b",
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                tool_payload(
                    "session-a-attempt",
                    "mcp__search",
                    tool_input,
                    session="session-a",
                ),
                state,
            ).returncode
            == 2
        )
        last_warning = None
        for index in range(3):
            last_warning = invoke(
                "tool-failure",
                failure_payload(
                    f"b-{index}",
                    "mcp__search",
                    tool_input,
                    session="session-b",
                ),
                state,
            )
        assert last_warning is not None
        assert "retry fuse is now active" in last_warning.stdout


def test_subagent_lifecycle_binds_within_its_root_session() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert (
            invoke(
                "pre-tool",
                agent_payload("start-a", session="root-a"),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("start-b", session="root-b"),
                state,
            ).returncode
            == 0
        )
        invoke(
            "subagent-start",
            start_payload("agent-b", session="root-b"),
            state,
        )
        guard_state = load_state(state)
        assert {item["session_id"] for item in guard_state["agent_pending"]} == {
            "root-a"
        }
        assert {
            item["session_id"]: item["agent_id"] for item in guard_state["agent_leases"]
        } == {"root-b": "agent-b"}

        invoke(
            "subagent-start",
            start_payload("agent-a", session="root-a"),
            state,
        )
        invoke(
            "subagent-stop",
            stop_payload("agent-b", session="root-b"),
            state,
        )
        leases = load_state(state)["agent_leases"]
        assert len(leases) == 1
        assert leases[0]["session_id"] == "root-a"
        assert leases[0]["agent_id"] == "agent-a"


def test_orphan_subagent_start_is_tracked_and_idempotent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        payload = start_payload("orphan-agent", session="root-a")
        assert invoke("subagent-start", payload, state).returncode == 0
        assert invoke("subagent-start", payload, state).returncode == 0
        guard_state = load_state(state)
        assert len(guard_state["agent_leases"]) == 1
        assert len(guard_state["agent_history"]) == 1


def test_v1_agent_resumes_migrate_into_rolling_history() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        state.write_text(
            json.dumps(
                {
                    "version": 1,
                    "agent_resumes": [
                        {
                            "at": NOW,
                            "session_id": "legacy",
                            "tool_use_id": f"legacy-{index}",
                            "target": f"agent-{index}",
                            "kind": "resume",
                        }
                        for index in range(12)
                    ],
                }
            ),
            encoding="utf-8",
        )
        blocked = invoke(
            "pre-tool",
            agent_payload("after-migration"),
            state,
            extra_env={"AGENT_GUARD_AGENT_MAX": "100"},
        )
        assert blocked.returncode == 2
        assert "rolling agent guard" in blocked.stderr
        assert len(load_state(state)["agent_history"]) == 12


def test_v4_anonymous_leases_migrate_to_pending_without_ghost_history() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        anonymous = {
            "at": NOW,
            "session_id": "legacy-v4",
            "tool_use_id": "awaiting-permission",
            "target": "",
            "kind": "start",
        }
        confirmed = {
            "at": NOW,
            "session_id": "legacy-v4",
            "tool_use_id": "already-started",
            "target": "agent-id",
            "agent_id": "agent-id",
            "kind": "start",
        }
        state.write_text(
            json.dumps(
                {
                    "version": 4,
                    "agent_leases": [anonymous, confirmed],
                    "agent_history": [anonymous, confirmed],
                }
            ),
            encoding="utf-8",
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("/status", session="legacy-v4"),
                state,
            ).returncode
            == 0
        )
        migrated = load_state(state)
        assert migrated["version"] == 5
        assert {item["tool_use_id"] for item in migrated["agent_pending"]} == {
            "awaiting-permission"
        }
        assert {item["tool_use_id"] for item in migrated["agent_leases"]} == {
            "already-started"
        }
        assert {item["tool_use_id"] for item in migrated["agent_history"]} == {
            "already-started"
        }


def test_old_subagent_request_is_not_counted_in_rolling_context() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        nested_dir = root / "session" / "subagents"
        nested_dir.mkdir(parents=True)
        old_transcript = nested_dir / "old-agent.jsonl"
        write_transcript(old_transcript, NOW - 3600, 20_000_000)
        assert (
            invoke(
                "pre-tool",
                tool_payload(
                    "old-agent-read",
                    "Read",
                    {"file_path": "README.md"},
                    transcript=old_transcript,
                ),
                state,
                extra_env={"AGENT_GUARD_TOOL_MAX": "100"},
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("new-root-agent"),
                state,
            ).returncode
            == 0
        )


def test_historical_resume_all_replay_allows_four_and_blocks_five() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, [f"agent-{index}" for index in range(9)])
        codes = [
            invoke(
                "pre-tool",
                send_payload(f"resume-{index}", f"agent-{index}"),
                state,
            ).returncode
            for index in range(9)
        ]
        assert codes.count(0) == 4, codes
        assert codes.count(2) == 5, codes


def test_historical_recursive_research_shape_is_stopped_at_first_nesting() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        nested_dir = root / "session" / "subagents"
        nested_dir.mkdir(parents=True)
        child = nested_dir / "agent-researcher.jsonl"
        write_transcript(child, NOW - 1, 50_000)

        assert (
            invoke("pre-tool", agent_payload("root-research-1"), state).returncode == 0
        )
        assert (
            invoke("pre-tool", agent_payload("root-research-2"), state).returncode == 0
        )
        for index in range(20):
            blocked = invoke(
                "pre-tool",
                agent_payload(
                    f"nested-research-{index}",
                    transcript=child,
                ),
                state,
            )
            assert blocked.returncode == 2
            if index < 4:
                assert "nested-agent guard" in blocked.stderr
            else:
                # The 5th identical denial trips the session agent fuse; the
                # replayed storm stays mechanically denied from then on.
                assert "agent fuse" in blocked.stderr
        guard_state = load_state(state)
        assert len(guard_state["agent_pending"]) == 2
        assert guard_state["agent_history"] == []


def fill_active_slots(state: Path) -> None:
    assert invoke("pre-tool", agent_payload("slot-1"), state).returncode == 0
    assert invoke("pre-tool", agent_payload("slot-2"), state).returncode == 0
    assert invoke("pre-tool", agent_payload("slot-3"), state).returncode == 0
    assert invoke("pre-tool", agent_payload("slot-4"), state).returncode == 0


def blocked_agent_attempt(
    state: Path,
    index: int,
    *,
    description: str = "Same blocked work",
    session: str = "parent-a",
    now: int = NOW,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    proc = invoke(
        "pre-tool",
        agent_payload(f"retry-{index}", description, session=session),
        state,
        now=now,
        extra_env=extra_env,
    )
    assert proc.returncode == 2
    return proc


def test_repeated_block_messages_escalate_and_never_repeat() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        fill_active_slots(state)
        first = blocked_agent_attempt(state, 1)
        assert "4 agents are already active" in first.stderr
        assert "denial 1" in first.stderr
        second = blocked_agent_attempt(state, 2)
        assert "denial 2" in second.stderr
        assert "4 agents are already active" in second.stderr
        third = blocked_agent_attempt(state, 3)
        assert "denial 3" in third.stderr
        assert "end the turn" in third.stderr.lower()
        fourth = blocked_agent_attempt(state, 4)
        assert "denial 4" in fourth.stderr
        assert "agent fuse" in fourth.stderr
        texts = {first.stderr, second.stderr, third.stderr, fourth.stderr}
        assert len(texts) == 4


def test_fuse_warning_reports_configured_subminute_duration_exactly() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        fill_active_slots(state)
        for index in range(1, 4):
            blocked_agent_attempt(state, index)
        warning = blocked_agent_attempt(
            state,
            4,
            extra_env={"AGENT_GUARD_BLOCK_FUSE_SECONDS": "90"},
        )
        assert "for 90 seconds" in warning.stderr
        assert "for 1 minutes" not in warning.stderr


def test_block_ladder_is_scoped_per_call_fingerprint() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        fill_active_slots(state)
        blocked_agent_attempt(state, 1, description="First blocked call")
        blocked_agent_attempt(state, 2, description="First blocked call")
        other = blocked_agent_attempt(state, 3, description="Different call")
        assert "denial 1" in other.stderr


def test_agent_fuse_trips_blocks_session_scoped_and_expires() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        fill_active_slots(state)
        for index in range(1, 5):
            blocked_agent_attempt(state, index)
        tripped = blocked_agent_attempt(state, 5)
        assert "agent fuse" in tripped.stderr
        assert "tripped" in tripped.stderr

        # A different agent call in the fused session is also denied.
        other_call = blocked_agent_attempt(state, 6, description="Unrelated work")
        assert "agent fuse" in other_call.stderr

        # Free both slots so only the fuse can deny.
        assert (
            invoke("subagent-start", start_payload("agent-one"), state).returncode == 0
        )
        assert (
            invoke("subagent-start", start_payload("agent-two"), state).returncode == 0
        )
        assert invoke("subagent-stop", stop_payload("agent-one"), state).returncode == 0
        assert invoke("subagent-stop", stop_payload("agent-two"), state).returncode == 0

        still_fused = blocked_agent_attempt(state, 7, description="Post-free work")
        assert "agent fuse" in still_fused.stderr

        # The fuse is per-session: another session may spawn.
        assert (
            invoke(
                "pre-tool",
                agent_payload("other-1", "Post-free work", session="parent-b"),
                state,
            ).returncode
            == 0
        )

        # The fuse and the block history expire with time.
        assert (
            invoke(
                "pre-tool",
                agent_payload("after-expiry", "Post-free work"),
                state,
                now=NOW + 601,
            ).returncode
            == 0
        )


def test_usage_override_bypasses_agent_fuse() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        fill_active_slots(state)
        for index in range(1, 6):
            blocked_agent_attempt(state, index)
        assert (
            invoke(
                "prompt",
                prompt_payload(
                    "[allow-usage-guard]\ndeliberate burst", session="parent-a"
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("post-override", "Deliberate work"),
                state,
            ).returncode
            == 0
        )


def test_non_agent_blocks_escalate_but_never_trip_agent_fuse() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        bash_input = {"command": "curl https://flaky.example"}
        for index in range(3):
            assert (
                invoke(
                    "tool-failure",
                    failure_payload(
                        f"fail-{index}", "Bash", bash_input, session="parent-a"
                    ),
                    state,
                ).returncode
                == 0
            )
        last = None
        for index in range(1, 7):
            last = invoke(
                "pre-tool",
                tool_payload(f"retry-{index}", "Bash", bash_input, session="parent-a"),
                state,
            )
            assert last.returncode == 2
        assert last is not None
        assert "denial 6" in last.stderr
        assert "agent fuse" not in last.stderr
        # Agent actions in the same session are unaffected.
        assert invoke("pre-tool", agent_payload("still-fine"), state).returncode == 0


def test_malformed_input_and_disabled_guard_fail_open() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        malformed = subprocess.run(
            [sys.executable, str(GUARD), "prompt"],
            input="{not-json",
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "AGENT_GUARD_STATE": str(state),
            },
            check=False,
        )
        assert malformed.returncode == 0
        transcript = root / "malformed-usage.jsonl"
        transcript.write_text(
            json.dumps(
                {
                    "type": "assistant",
                    "timestamp": "2033-05-18T03:33:19Z",
                    "requestId": "malformed-usage",
                    "message": {
                        "model": "claude-test",
                        "usage": {
                            "input_tokens": "not-a-number",
                            "cache_creation_input_tokens": float("inf"),
                            "cache_read_input_tokens": {"invalid": True},
                        },
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        malformed_usage = invoke(
            "prompt",
            prompt_payload("continue", transcript=transcript),
            state,
        )
        assert malformed_usage.returncode == 0
        disabled = invoke(
            "prompt",
            prompt_payload("resume all agents"),
            state,
            extra_env={"AGENT_GUARD": "0"},
        )
        assert disabled.returncode == 0


def test_invalid_and_below_minimum_environment_limits_are_safe() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        invalid_state = root / "invalid.json"
        invalid_env = {"AGENT_GUARD_AGENT_MAX": "not-an-integer"}
        for index in range(1, 5):
            assert (
                invoke(
                    "pre-tool",
                    agent_payload(f"invalid-{index}"),
                    invalid_state,
                    extra_env=invalid_env,
                ).returncode
                == 0
            )
        assert (
            invoke(
                "pre-tool",
                agent_payload("invalid-5"),
                invalid_state,
                extra_env=invalid_env,
            ).returncode
            == 2
        )

        minimum_state = root / "minimum.json"
        minimum_env = {"AGENT_GUARD_AGENT_MAX": "-10"}
        assert (
            invoke(
                "pre-tool",
                agent_payload("minimum-1"),
                minimum_state,
                extra_env=minimum_env,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("minimum-2"),
                minimum_state,
                extra_env=minimum_env,
            ).returncode
            == 2
        )


def test_corrupt_state_recovers_and_deep_transcript_line_is_skipped() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        state.write_bytes(b"\xff\xfe\x00not-json")
        assert (
            invoke(
                "pre-tool",
                agent_payload("after-corrupt-state"),
                state,
            ).returncode
            == 0
        )
        assert len(load_state(state)["agent_pending"]) == 1

        state.write_text("[" * 2000 + "]" * 2000, encoding="utf-8")
        assert (
            invoke(
                "pre-tool",
                agent_payload("after-deep-state"),
                state,
            ).returncode
            == 0
        )
        assert len(load_state(state)["agent_pending"]) == 1

        transcript = root / "deep-line.jsonl"
        valid_record = assistant_record(NOW - 1, 600_000, "after-deep-line")
        transcript.write_text(
            "[" * 2000 + "]" * 2000 + "\n" + json.dumps(valid_record) + "\n",
            encoding="utf-8",
        )
        blocked = invoke(
            "prompt",
            prompt_payload("continue", transcript=transcript),
            state,
        )
        assert blocked.returncode == 2
        assert "context guard" in blocked.stderr


def test_workflow_is_denied_for_every_current_input_shape() -> None:
    shapes = [
        {"script": "await agent({prompt: 'x'})"},
        {"name": "deep-research", "args": "inspect"},
        {"scriptPath": "/tmp/workflow.js"},
        {"scriptPath": "/tmp/workflow.js", "args": "inspect"},
        {"scriptPath": "/tmp/workflow.js", "resumeFromRunId": "run-1"},
        {
            "scriptPath": "/tmp/workflow.js",
            "resumeFromRunId": "run-1",
            "args": "inspect",
        },
    ]
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        for index, shape in enumerate(shapes):
            blocked = invoke(
                "pre-tool",
                tool_payload(f"workflow-{index}", "Workflow", shape),
                state,
            )
            assert blocked.returncode == 2
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_leases"] == []
        assert guard_state["agent_history"] == []


def test_explicit_override_allows_workflow_without_counting_it_as_one_agent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert (
            invoke(
                "prompt",
                prompt_payload(
                    "[allow-agent-burst]\ndeliberate workflow",
                    session="workflow-session",
                ),
                state,
            ).returncode
            == 0
        )
        allowed = invoke(
            "pre-tool",
            tool_payload(
                "workflow-override",
                "Workflow",
                {"name": "deep-research", "args": "inspect"},
                session="workflow-session",
            ),
            state,
        )
        assert allowed.returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_history"] == []


def test_deep_research_expansion_is_blocked_unless_explicitly_bypassed() -> None:
    payload = {
        "hook_event_name": "UserPromptExpansion",
        "session_id": "deep-session",
        "command_name": "deep-research",
        "command_args": "inspect",
        "prompt": "/deep-research inspect",
    }
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        blocked = invoke("prompt-expansion", payload, state)
        assert blocked.returncode == 2
        assert "opaque Workflow" in blocked.stderr
        assert (
            invoke(
                "prompt",
                prompt_payload(
                    "[allow-agent-burst]\ndeliberate deep research",
                    session="deep-session",
                ),
                state,
            ).returncode
            == 0
        )
        allowed = invoke("prompt-expansion", payload, state)
        assert allowed.returncode == 0
        assert "explicitly bypassed" in allowed.stdout


def test_manual_denial_without_permission_event_reconciles_from_transcript() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "parent.jsonl"
        write_transcript(transcript, NOW - 1, 10_000)
        attempted = agent_payload("manual-denial", transcript=transcript)
        assert invoke("pre-tool", attempted, state).returncode == 0
        denial = {
            "type": "user",
            "toolDenialKind": "user-rejected",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "manual-denial",
                        "content": "User denied this operation",
                        "is_error": True,
                    }
                ],
            },
        }
        with transcript.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(denial) + "\n")
        assert (
            invoke("pre-tool", agent_payload("after-denial-1"), state).returncode == 0
        )
        assert (
            invoke("pre-tool", agent_payload("after-denial-2"), state).returncode == 0
        )
        guard_state = load_state(state)
        assert {item["tool_use_id"] for item in guard_state["agent_pending"]} == {
            "after-denial-1",
            "after-denial-2",
        }
        assert all(item["id"] != "manual-denial" for item in guard_state["tool_events"])


def test_permission_rule_denial_reconciles_on_another_session_hook() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "parent.jsonl"
        write_transcript(transcript, NOW - 1, 10_000)
        attempted = agent_payload(
            "rule-denial",
            session="denied-session",
            transcript=transcript,
        )
        assert invoke("pre-tool", attempted, state).returncode == 0
        denial = {
            "type": "user",
            "toolDenialKind": "permission-rule",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "rule-denial",
                    }
                ]
            },
        }
        with transcript.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(denial) + "\n")
        assert (
            invoke(
                "pre-tool",
                agent_payload("other-session", session="other-session"),
                state,
            ).returncode
            == 0
        )
        assert {item["tool_use_id"] for item in load_state(state)["agent_pending"]} == {
            "other-session"
        }


def test_unresolved_pending_reservation_expires_without_poisoning_history() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert invoke("pre-tool", agent_payload("abandoned"), state).returncode == 0
        assert (
            invoke(
                "pre-tool",
                agent_payload("later-1"),
                state,
                now=NOW + 301,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "pre-tool",
                agent_payload("later-2"),
                state,
                now=NOW + 301,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert all(
            item["tool_use_id"] != "abandoned" for item in guard_state["agent_pending"]
        )
        assert all(item["id"] != "abandoned" for item in guard_state["tool_events"])
        assert guard_state["agent_history"] == []


def test_confirmed_start_uses_actual_start_time_and_clears_pending() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert invoke("pre-tool", agent_payload("delayed"), state).returncode == 0
        assert (
            invoke(
                "subagent-start",
                start_payload("delayed-id"),
                state,
                now=NOW + 299,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_leases"][0]["at"] == NOW + 299
        assert guard_state["agent_history"][0]["source"] == "confirmed_start"


def test_fork_lifecycle_start_cannot_steal_direct_agent_reservation() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert (
            invoke("pre-tool", agent_payload("direct-pending"), state).returncode == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload("fork-id", agent_type="fork"),
                state,
                now=NOW + 1,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert {item["tool_use_id"] for item in guard_state["agent_pending"]} == {
            "direct-pending"
        }
        assert guard_state["agent_leases"][0]["source"] == "observed_unreserved"
        assert guard_state["agent_history"][0]["source"] == "observed_unreserved"


def test_fork_type_name_collision_still_cannot_claim_direct_reservation() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        direct = tool_payload(
            "named-fork",
            "Agent",
            {
                "description": "ordinary direct agent named fork",
                "prompt": "inspect",
                "subagent_type": "general-purpose",
                "name": "fork",
            },
            session="parent-a",
        )
        assert invoke("pre-tool", direct, state).returncode == 0
        assert (
            invoke(
                "subagent-start",
                start_payload("actual-fork-id", agent_type="fork"),
                state,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert {item["tool_use_id"] for item in guard_state["agent_pending"]} == {
            "named-fork"
        }
        assert guard_state["agent_leases"][0]["source"] == "observed_unreserved"


def test_delayed_stop_never_deletes_pending_resume() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, ["agent-x"])
        assert (
            invoke("pre-tool", send_payload("pending-x", "agent-x"), state).returncode
            == 0
        )
        assert invoke("subagent-stop", stop_payload("agent-x"), state).returncode == 0
        assert {item["tool_use_id"] for item in load_state(state)["agent_pending"]} == {
            "pending-x"
        }


def test_second_pending_resume_to_the_same_target_is_blocked() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, ["agent-x"])
        assert (
            invoke("pre-tool", send_payload("resume-1", "agent-x"), state).returncode
            == 0
        )
        duplicate = invoke(
            "pre-tool",
            send_payload("resume-2", "agent-x"),
            state,
        )
        assert duplicate.returncode == 2
        assert "still awaiting confirmation" in duplicate.stderr
        assert {item["tool_use_id"] for item in load_state(state)["agent_pending"]} == {
            "resume-1"
        }


def test_resume_aliases_resolving_to_same_agent_share_one_pending_slot() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        state.write_text(
            json.dumps(
                {
                    "version": 5,
                    "known_agents": [
                        {
                            "at": NOW,
                            "session_id": "parent-a",
                            "target": alias,
                            "agent_id": "agent-x",
                        }
                        for alias in ("worker", "general-purpose")
                    ],
                }
            ),
            encoding="utf-8",
        )
        assert (
            invoke("pre-tool", send_payload("by-name", "worker"), state).returncode == 0
        )
        duplicate = invoke(
            "pre-tool",
            send_payload("by-type", "general-purpose"),
            state,
        )
        assert duplicate.returncode == 2
        assert {item["tool_use_id"] for item in load_state(state)["agent_pending"]} == {
            "by-name"
        }


def test_active_agent_coordination_through_an_alias_never_reserves_resume() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        state.write_text(
            json.dumps(
                {
                    "version": 5,
                    "agent_leases": [
                        {
                            "at": NOW,
                            "session_id": "parent-a",
                            "tool_use_id": "running-worker",
                            "target": "worker",
                            "agent_id": "agent-x",
                            "kind": "start",
                        }
                    ],
                    "known_agents": [
                        {
                            "at": NOW,
                            "session_id": "parent-a",
                            "target": "general-purpose",
                            "agent_id": "agent-x",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        steering = send_payload(
            "steer-by-type",
            "general-purpose",
            message="Please send your current findings.",
        )
        assert invoke("pre-tool", steering, state).returncode == 0
        assert load_state(state)["agent_pending"] == []


def test_stop_defensively_releases_all_duplicate_exact_leases() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        state.write_text(
            json.dumps(
                {
                    "version": 5,
                    "agent_leases": [
                        {
                            "at": NOW,
                            "session_id": "parent-a",
                            "tool_use_id": f"duplicate-{index}",
                            "target": "agent-x",
                            "agent_id": "agent-x",
                            "kind": "resume",
                        }
                        for index in range(2)
                    ],
                }
            ),
            encoding="utf-8",
        )
        assert invoke("subagent-stop", stop_payload("agent-x"), state).returncode == 0
        assert load_state(state)["agent_leases"] == []


def test_sendmessage_posttool_confirms_resume_without_subagentstart() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        alias = "code-reviewer"
        assert (
            invoke(
                "pre-tool",
                agent_payload("initial", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload("reviewer-id", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload("reviewer-id", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        resumed = send_payload(
            "resume-posttool",
            alias,
            message="Now inspect authorization.",
        )
        assert invoke("pre-tool", resumed, state).returncode == 0
        post = dict(resumed)
        post["hook_event_name"] = "PostToolUse"
        post["tool_response"] = {
            "success": True,
            "resumedAgentId": "reviewer-id",
            "status": "running",
        }
        assert invoke("post-tool", post, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_leases"][0]["agent_id"] == "reviewer-id"
        assert (
            invoke(
                "subagent-stop",
                stop_payload("reviewer-id", agent_type=alias),
                state,
            ).returncode
            == 0
        )
        assert load_state(state)["agent_leases"] == []


def test_synchronous_sendmessage_completion_never_leaves_active_lease() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, ["agent-a", "agent-b"])
        for target in ("agent-a", "agent-b"):
            resumed = send_payload(
                f"resume-{target}",
                target,
                message="Finish the next bounded check.",
            )
            assert invoke("pre-tool", resumed, state).returncode == 0
            post = dict(resumed)
            post["hook_event_name"] = "PostToolUse"
            post["tool_response"] = {
                "success": True,
                "message": (
                    f"Agent {target} had no active task; resumed from saved "
                    "context and ran to completion. Result: done"
                ),
            }
            assert invoke("post-tool", post, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_leases"] == []
        assert len(guard_state["agent_history"]) == 2
        assert all(
            item["source"] == "confirmed_tool_completion"
            for item in guard_state["agent_history"]
        )
        assert invoke("pre-tool", agent_payload("next-real"), state).returncode == 0


def test_remote_and_teammate_launch_statuses_hold_active_slots() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        response_shapes = (
            {"status": "remote_launched", "taskId": "task-0"},
            {
                "status": "teammate_spawned",
                "teammate_id": "teammate-1",
                "name": "reviewer",
            },
        )
        for index, response in enumerate(response_shapes):
            attempted = agent_payload(f"launch-{index}")
            assert invoke("pre-tool", attempted, state).returncode == 0
            post = dict(attempted)
            post["hook_event_name"] = "PostToolUse"
            post["tool_response"] = response
            assert invoke("post-tool", post, state).returncode == 0
            assert (
                invoke(
                    "subagent-start",
                    start_payload(
                        str(response.get("taskId") or response.get("teammate_id"))
                    ),
                    state,
                ).returncode
                == 0
            )
        guard_state = load_state(state)
        assert len(guard_state["agent_leases"]) == 2
        assert len(guard_state["agent_history"]) == 2
        assert invoke("pre-tool", agent_payload("filler-3"), state).returncode == 0
        assert invoke("pre-tool", agent_payload("filler-4"), state).returncode == 0
        blocked = invoke("pre-tool", agent_payload("fifth-launch"), state)
        assert blocked.returncode == 2
        assert "already active or reserved" in blocked.stderr


def test_async_launch_without_response_id_waits_for_lifecycle_id() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        attempted = agent_payload("async-launch")
        assert invoke("pre-tool", attempted, state).returncode == 0
        post = dict(attempted)
        post["hook_event_name"] = "PostToolUse"
        post["tool_response"] = {"status": "async_launched"}
        assert invoke("post-tool", post, state).returncode == 0
        assert len(load_state(state)["agent_pending"]) == 1
        assert (
            invoke(
                "subagent-start",
                start_payload("async-agent-id"),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload("async-agent-id"),
                state,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_leases"] == []
        assert len(guard_state["agent_history"]) == 1


def test_string_posttool_agent_id_confirms_exactly_one_lifecycle() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        attempted = agent_payload("string-id-launch")
        assert invoke("pre-tool", attempted, state).returncode == 0
        post = dict(attempted)
        post["hook_event_name"] = "PostToolUse"
        post["tool_response"] = (
            "Async agent launched successfully. agentId: string-agent-id"
        )
        assert invoke("post-tool", post, state).returncode == 0
        assert (
            invoke(
                "subagent-start",
                start_payload("string-agent-id"),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload("string-agent-id"),
                state,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_leases"] == []
        assert len(guard_state["agent_history"]) == 1


def test_background_sendmessage_without_response_id_uses_known_agent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, ["background-agent"])
        attempted = send_payload(
            "background-resume",
            "background-agent",
            message="Continue the bounded review.",
        )
        assert invoke("pre-tool", attempted, state).returncode == 0
        post = dict(attempted)
        post["hook_event_name"] = "PostToolUse"
        post["tool_response"] = {
            "success": True,
            "message": (
                "Agent background-agent had no active task; resumed from "
                "transcript in the background"
            ),
        }
        assert invoke("post-tool", post, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert len(guard_state["agent_leases"]) == 1
        assert guard_state["agent_leases"][0]["agent_id"] == "background-agent"
        assert len(guard_state["agent_history"]) == 1


def test_six_failed_resumes_do_not_consume_confirmed_rolling_budget() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        seed_known_agents(state, [f"agent-{index}" for index in range(6)])
        for index in range(6):
            attempted = send_payload(f"failed-{index}", f"agent-{index}")
            assert invoke("pre-tool", attempted, state).returncode == 0
            failure = failure_payload(
                f"failed-{index}",
                "SendMessage",
                attempted["tool_input"],
                session="parent-a",
            )
            assert invoke("tool-failure", failure, state).returncode == 0
        guard_state = load_state(state)
        assert guard_state["agent_pending"] == []
        assert guard_state["agent_history"] == []
        assert invoke("pre-tool", agent_payload("real-start"), state).returncode == 0


def test_structured_and_unknown_send_messages_do_not_reserve_agents() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        structured = tool_payload(
            "shutdown",
            "SendMessage",
            {
                "to": "agent-x",
                "message": {"type": "shutdown_request", "reason": "done"},
            },
            session="parent-a",
        )
        unknown = send_payload(
            "unknown-resume",
            "never-observed",
            message="Resume where you left off.",
        )
        assert invoke("pre-tool", structured, state).returncode == 0
        assert invoke("pre-tool", unknown, state).returncode == 0
        assert load_state(state)["agent_pending"] == []


def test_official_stopfailure_fields_arm_the_circuit_breaker() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        payload = {
            "hook_event_name": "StopFailure",
            "session_id": "official-contract",
            "error_type": "rate_limit",
            "error_message": "You've hit your session limit · resets in 2 hours",
        }
        assert invoke("stop-failure", payload, state).returncode == 0
        assert load_state(state)["rate_limit"]["until"] == NOW + 2 * 60 * 60


def test_weekly_weekday_reset_uses_the_next_matching_local_day() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload(
                    "You've hit your weekly limit · resets Mon 12:00am"
                ),
                state,
                extra_env={"TZ": "Europe/London"},
            ).returncode
            == 0
        )
        current = datetime.fromtimestamp(NOW, ZoneInfo("Europe/London"))
        expected = current.replace(hour=0, minute=0, second=0, microsecond=0)
        expected += timedelta(days=(0 - current.weekday()) % 7)
        if expected.timestamp() <= NOW:
            expected += timedelta(days=7)
        assert load_state(state)["rate_limit"]["until"] == expected.timestamp()


def test_opus_only_limit_does_not_arm_global_circuit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload(
                    "You've hit your weekly Opus limit · switch models to continue"
                ),
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("continue on Sonnet"),
                state,
            ).returncode
            == 0
        )
        assert load_state(state)["rate_limit"] is None


def test_unrelated_opus_prose_does_not_hide_a_global_rate_limit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        payload = {
            "hook_event_name": "StopFailure",
            "session_id": "global-limit-with-opus-prose",
            "error_type": "rate_limit",
            "error_message": "5-hour limit reached · resets in 2 hours",
            "last_assistant_message": "We are also close to your Opus limit.",
        }
        assert invoke("stop-failure", payload, state).returncode == 0
        assert load_state(state)["rate_limit"]["until"] == NOW + 2 * 60 * 60


def test_compaction_boundary_outlives_the_rolling_window() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "large.jsonl"
        write_transcript(transcript, NOW - 1, 600_000)
        assert (
            invoke(
                "post-compact",
                {
                    "hook_event_name": "PostCompact",
                    "session_id": "compacted",
                    "transcript_path": str(transcript),
                },
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt",
                prompt_payload("bounded work", "compacted", transcript),
                state,
                now=NOW + 31 * 24 * 60 * 60,
            ).returncode
            == 0
        )


def test_subagent_usage_never_clears_parent_compaction_boundary() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        parent = root / "parent.jsonl"
        child_dir = root / "subagents"
        child_dir.mkdir()
        child = child_dir / "agent-child.jsonl"
        write_transcript(parent, NOW - 1, 600_000)
        write_transcript(child, NOW + 10, 100_000)
        assert (
            invoke(
                "post-compact",
                {
                    "hook_event_name": "PostCompact",
                    "session_id": "parent-session",
                    "transcript_path": str(parent),
                },
                state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload(
                    "child-id",
                    transcript=parent,
                    agent_transcript=child,
                    session="parent-session",
                ),
                state,
                now=NOW + 11,
            ).returncode
            == 0
        )
        assert "parent-session" in load_state(state)["compactions"]
        assert (
            invoke(
                "prompt",
                prompt_payload("bounded parent work", "parent-session", parent),
                state,
                now=NOW + 20,
            ).returncode
            == 0
        )


def test_escape_marker_mentions_do_not_activate_an_override() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        invoke(
            "stop-failure",
            stop_failure_payload("Rate limit reached · resets in 30 minutes"),
            state,
        )
        mentioned = invoke(
            "prompt",
            prompt_payload(
                "Explain what [allow-usage-guard] means.",
                session="marker-session",
            ),
            state,
        )
        assert mentioned.returncode == 2
        assert load_state(state)["usage_overrides"] == {}
        deliberate = invoke(
            "prompt",
            prompt_payload(
                "[allow-usage-guard]\ncontinue deliberately",
                session="marker-session",
            ),
            state,
        )
        assert deliberate.returncode == 0
        assert "full usage bypass is active" in deliberate.stdout
        assert "marker-session" in load_state(state)["usage_overrides"]


def test_stop_observation_records_latest_request_and_drives_context_gate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "session.jsonl"
        transcript.write_text(
            "\n".join(
                (
                    json.dumps(assistant_record(NOW - 30, 50_000, "older")),
                    "{not valid json",
                    json.dumps(
                        {
                            "type": "assistant",
                            "timestamp": datetime.fromtimestamp(
                                NOW - 20,
                                timezone.utc,
                            )
                            .isoformat()
                            .replace("+00:00", "Z"),
                            "message": {
                                "model": "<synthetic>",
                                "usage": {"input_tokens": 900_000},
                            },
                        }
                    ),
                    json.dumps(assistant_record(NOW - 10, 550_000, "latest")),
                )
            )
            + "\n",
            encoding="utf-8",
        )
        observed = invoke(
            "observe-stop",
            {
                "hook_event_name": "Stop",
                "session_id": "observed-session",
                "transcript_path": str(transcript),
            },
            state,
        )
        assert observed.returncode == 0
        usage = load_state(state)["usage_events"]
        assert len(usage) == 1
        assert usage[0]["id"] == "latest"
        assert usage[0]["context"] == 550_000
        assert usage[0]["session_id"] == "observed-session"
        assert set(usage[0]) == {
            "at",
            "context",
            "id",
            "model",
            "retention_until",
            "session_id",
            "subagent",
        }

        blocked = invoke(
            "prompt",
            prompt_payload("Continue bounded work.", "observed-session"),
            state,
        )
        assert blocked.returncode == 2
        assert "context guard" in blocked.stderr


def test_reset_parser_handles_daily_and_weekday_24_hour_clocks() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        daily_state = root / "daily.json"
        weekday_state = root / "weekday.json"
        next_week_state = root / "next-week.json"
        invalid_state = root / "invalid.json"
        local_now = datetime.fromtimestamp(NOW, ZoneInfo("Europe/London"))

        daily_hour = (local_now.hour + 2) % 24
        daily_message = (
            f"Rate limit reached · resets at {daily_hour:02d}:17 (Europe/London)"
        )
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload(daily_message),
                daily_state,
            ).returncode
            == 0
        )
        daily_expected = local_now.replace(
            hour=daily_hour,
            minute=17,
            second=0,
            microsecond=0,
        )
        if daily_expected.timestamp() <= NOW:
            daily_expected += timedelta(days=1)
        assert (
            load_state(daily_state)["rate_limit"]["until"] == daily_expected.timestamp()
        )

        target = local_now + timedelta(days=3)
        weekday_message = (
            "Rate limit reached · resets "
            f"{target.strftime('%A')} at 23:41 (Europe/London)"
        )
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload(weekday_message),
                weekday_state,
            ).returncode
            == 0
        )
        weekday_expected = local_now.replace(
            hour=23,
            minute=41,
            second=0,
            microsecond=0,
        ) + timedelta(days=3)
        assert (
            load_state(weekday_state)["rate_limit"]["until"]
            == weekday_expected.timestamp()
        )

        earlier = local_now - timedelta(minutes=1)
        next_week_message = (
            "Rate limit reached · resets "
            f"{local_now.strftime('%A')} at {earlier:%H:%M} (Europe/London)"
        )
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload(next_week_message),
                next_week_state,
            ).returncode
            == 0
        )
        next_week_expected = local_now.replace(
            hour=earlier.hour,
            minute=earlier.minute,
            second=0,
            microsecond=0,
        ) + timedelta(days=7)
        assert (
            load_state(next_week_state)["rate_limit"]["until"]
            == next_week_expected.timestamp()
        )

        assert (
            invoke(
                "stop-failure",
                stop_failure_payload("Rate limit reached · resets at 25:61"),
                invalid_state,
            ).returncode
            == 0
        )
        assert load_state(invalid_state)["rate_limit"]["until"] == NOW + 5 * 60


def test_stop_failure_ignores_irrelevant_events_and_never_shortens_cooldown() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        irrelevant = stop_failure_payload(
            "ordinary model error",
            error="authentication_failed",
        )
        assert invoke("stop-failure", irrelevant, state).returncode == 0
        assert not state.exists()

        assert (
            invoke(
                "stop-failure",
                stop_failure_payload("Session limit reached · resets in 2 hours"),
                state,
            ).returncode
            == 0
        )
        first = load_state(state)["rate_limit"]
        assert first["until"] == NOW + 2 * 60 * 60
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload("Rate limit reached · resets in 10 minutes"),
                state,
                now=NOW + 1,
            ).returncode
            == 0
        )
        assert load_state(state)["rate_limit"] == first


def test_research_expansion_honors_active_usage_circuit_breaker() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload("Rate limit reached · resets in 30 minutes"),
                state,
            ).returncode
            == 0
        )
        blocked = invoke("prompt-expansion", research_payload(), state)
        assert blocked.returncode == 2
        assert "usage circuit breaker" in blocked.stderr


def test_new_parent_usage_after_compaction_clears_the_boundary() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "state.json"
        transcript = root / "session.jsonl"
        assert (
            invoke(
                "post-compact",
                {"hook_event_name": "PostCompact", "session_id": "session-a"},
                state,
            ).returncode
            == 0
        )
        write_transcript(transcript, NOW + 1, 120_000, request_id="after-compact")
        assert (
            invoke(
                "observe-stop",
                {
                    "hook_event_name": "Stop",
                    "session_id": "session-a",
                    "transcript_path": str(transcript),
                },
                state,
                now=NOW + 1,
            ).returncode
            == 0
        )
        guard_state = load_state(state)
        assert "session-a" not in guard_state["compactions"]
        assert guard_state["usage_events"][0]["id"] == "after-compact"


def test_state_io_failures_preserve_static_safety_and_fail_open_elsewhere() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        parent_file = root / "not-a-directory"
        parent_file.write_text("occupied", encoding="utf-8")
        unavailable_state = parent_file / "state.json"

        broad = invoke(
            "prompt",
            prompt_payload("resume all agents"),
            unavailable_state,
        )
        assert broad.returncode == 2
        assert "small batches" in broad.stderr
        assert (
            invoke(
                "prompt",
                prompt_payload("continue bounded work"),
                unavailable_state,
            ).returncode
            == 0
        )

        workflow = invoke(
            "pre-tool",
            tool_payload("workflow", "Workflow", {"workflow": "research"}),
            unavailable_state,
        )
        assert workflow.returncode == 2
        assert "state was unavailable" in workflow.stderr
        assert (
            invoke(
                "pre-tool",
                tool_payload("read", "Read", {"file_path": "/tmp/example"}),
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "prompt-expansion",
                research_payload(),
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "tool-failure",
                failure_payload("read", "Read", {"file_path": "/tmp/example"}),
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "observe-stop",
                {"hook_event_name": "Stop", "session_id": "session"},
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "stop-failure",
                stop_failure_payload("Rate limit reached · resets in 10 minutes"),
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-start",
                start_payload("agent-id"),
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "subagent-stop",
                stop_payload("agent-id"),
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "permission-denied",
                {
                    "tool_name": "Read",
                    "tool_input": {"file_path": "/tmp/example"},
                    "tool_use_id": "read",
                    "session_id": "session",
                },
                unavailable_state,
            ).returncode
            == 0
        )
        assert (
            invoke(
                "post-compact",
                {"hook_event_name": "PostCompact", "session_id": "session"},
                unavailable_state,
            ).returncode
            == 0
        )


def test_missing_or_wrong_hook_fields_and_unknown_modes_fail_open() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state.json"
        cases = (
            ("unknown-mode", {"unexpected": True}),
            ("prompt-expansion", {"command_name": 42}),
            ("prompt-expansion", {"command_name": "compact"}),
            ("pre-tool", {"tool_name": "Read", "tool_input": "not-an-object"}),
            ("tool-failure", {"tool_name": None, "tool_input": {}}),
            (
                "post-tool",
                {"tool_name": "Read", "tool_use_id": "read", "tool_input": {}},
            ),
            ("stop-failure", {"error": "server_error"}),
            ("subagent-start", {"agent_id": None}),
            ("permission-denied", {"tool_name": "Read", "tool_use_id": None}),
            ("post-compact", {}),
        )
        for mode, payload in cases:
            proc = invoke(mode, payload, state)
            assert proc.returncode == 0, (mode, proc.stderr)
        assert not state.exists()


def test_demo_launcher_uses_disposable_fixture_and_hardened_cli_contract() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        binary_dir = root / "bin"
        binary_dir.mkdir()
        capture = root / "capture.json"
        fake_claude = binary_dir / "claude"
        fake_claude.write_text(
            f"""#!{sys.executable}
import json
import os
import sys
from pathlib import Path

cwd = Path.cwd()
Path(os.environ["AGENT_GUARD_DEMO_CAPTURE"]).write_text(json.dumps({{
    "argv": sys.argv[1:],
    "cwd": str(cwd),
    "files": sorted(str(path.relative_to(cwd)) for path in cwd.rglob("*") if path.is_file()),
    "state": os.environ.get("AGENT_GUARD_STATE"),
    "concurrent": os.environ.get("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"),
    "per_session": os.environ.get("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"),
    "depth": os.environ.get("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"),
}}), encoding="utf-8")
""",
            encoding="utf-8",
        )
        fake_claude.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = str(binary_dir) + os.pathsep + env.get("PATH", "")
        env["AGENT_GUARD_DEMO_CAPTURE"] = str(capture)
        proc = subprocess.run(
            [
                sys.executable,
                str(ROOT / "demo" / "run_demo.py"),
                "--model",
                "test-model",
            ],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
        result = json.loads(capture.read_text(encoding="utf-8"))
        assert result["concurrent"] == "20"
        assert result["per_session"] == "20"
        assert result["depth"] == "1"
        assert result["state"] == str(Path(result["cwd"]) / "guard-state.json")
        assert not Path(result["cwd"]).exists()
        assert result["files"] == [
            "README.md",
            "deploy/Dockerfile",
            "src/auth.py",
            "src/database.py",
        ]
        args = result["argv"]
        assert args[args.index("--plugin-dir") + 1] == str(ROOT)
        assert args[args.index("--mcp-config") + 1] == str(
            ROOT / "demo" / "empty-mcp.json"
        )
        assert args[args.index("--model") + 1] == "test-model"
        assert args[args.index("--session-id") + 1]
        assert "--strict-mcp-config" in args
        assert "--exclude-dynamic-system-prompt-sections" in args
        assert args[args.index("--permission-mode") + 1] == "bypassPermissions"


def test_demo_launcher_reports_missing_claude_cli() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        env = os.environ.copy()
        env["PATH"] = tmp
        proc = subprocess.run(
            [sys.executable, str(ROOT / "demo" / "run_demo.py")],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        assert proc.returncode == 1
        assert "Claude Code is required" in proc.stderr


def test_demo_gif_visual_contract_is_valid_animated_and_documented() -> None:
    gif = ROOT / "assets" / "agent-usage-guard.gif"
    width, height, frames, duration = gif_metadata(gif)
    assert (width, height) == (1200, 640)
    assert frames >= 24
    assert duration >= 100
    assert (
        hashlib.sha256(gif.read_bytes()).hexdigest()
        == "c97e29be69d0178458788709c4a4e53f133396c84529b046b64d82d3bbb77613"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert 'src="assets/agent-usage-guard.gif"' in readme
    assert "real interactive Claude Code UI" in readme
    tape = (ROOT / "demo" / "agent-usage-guard.tape").read_text(encoding="utf-8")
    assert "Output assets/agent-usage-guard.gif" in tape
    assert "Wait+Screen@120s /GUARD TRIGGERED/" in tape


def test_documented_test_count_matches_discovered_suite() -> None:
    count = sum(
        callable(value) and name.startswith("test_")
        for name, value in globals().items()
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    testing = (ROOT / "TESTING.md").read_text(encoding="utf-8")
    assert f"{count} end-to-end regression tests" in readme
    assert f"{count} tests on Python 3.9–3.14" in testing


def test_shipped_manifests_cover_every_runtime_mode() -> None:
    plugin_hooks = json.loads(
        (ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8")
    )["hooks"]
    manual_hooks = json.loads(
        (ROOT / "examples" / "settings-hooks.json").read_text(encoding="utf-8")
    )["hooks"]
    assert plugin_hooks.keys() == manual_hooks.keys()
    assert "matcher" not in plugin_hooks["StopFailure"][0]
    assert plugin_hooks["PermissionDenied"][0]["matcher"] == "*"
    assert plugin_hooks["UserPromptExpansion"][0]["matcher"] == "research|deep-research"
    assert plugin_hooks["PostToolUse"][0]["matcher"] == "Agent|Task|SendMessage"
    modes = {
        hook["command"].rsplit(" ", 1)[-1]
        for groups in plugin_hooks.values()
        for group in groups
        for hook in group["hooks"]
    }
    assert modes == {
        "observe-stop",
        "permission-denied",
        "post-compact",
        "post-tool",
        "pre-tool",
        "prompt",
        "prompt-expansion",
        "stop-failure",
        "subagent-start",
        "subagent-stop",
        "tool-failure",
    }
    marketplace = json.loads(
        (ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
    )
    assert marketplace.get("description")


def main() -> int:
    tests = [
        value for name, value in sorted(globals().items()) if name.startswith("test_")
    ]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"ok   {test.__name__}")
        except Exception:  # noqa: BLE001 - report all independent test failures.
            failed += 1
            print(f"FAIL {test.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
