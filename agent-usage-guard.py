#!/usr/bin/env python3
"""Global Claude Code usage guard for bursts, long contexts, and retry loops.

The guard is intentionally dependency-free and shares a small, privacy-minimal
state file across Claude processes. It implements six independent protections:

1. A StopFailure-driven rate-limit circuit breaker.
2. Active, rolling, nested, and context-based agent budgets.
3. Prompt context gates and high-context rolling-window tool budgets.
4. A default-deny gate for opaque Workflow fan-out, including /deep-research.
5. A repeated identical-tool-failure fuse.
6. An escalating denial ladder: repeated blocks of the same condition (or the
   same tool input for the error fuse) get differently-worded, attempt-numbered
   messages (never byte-identical text, which induces deterministic retry
   loops), and repeated agent-call denials trip a session-wide agent fuse as
   the mechanical stop.

Hook modes:

* ``prompt``              - UserPromptSubmit
* ``prompt-expansion``    - UserPromptExpansion (research)
* ``pre-tool``            - PreToolUse (all tools)
* ``post-tool``           - PostToolUse (agent attempt confirmation)
* ``tool-failure``        - PostToolUseFailure
* ``observe-stop``        - Stop
* ``stop-failure``        - StopFailure (rate_limit)
* ``subagent-start``      - SubagentStart
* ``subagent-stop``       - SubagentStop
* ``permission-denied``   - PermissionDenied (auto-mode denial rollback)
* ``post-compact``        - PostCompact
* ``report``              - local summary of interventions (CLI, not a hook)

An override marker bypasses limits for ten minutes only when it is the first
non-blank line of a user prompt and appears alone on that line.

State stores hashes, identifiers, timestamps, counters, and token estimates.
While permission is unresolved, a provisional record also holds the parent
transcript path and byte offset so manual denials can be reconciled; it expires
after five minutes by default. Prompt text, tool inputs, errors, and assistant
output are never stored.

Exit 0 allows the event. Exit 2 blocks events that support blocking. Malformed
hook data cannot wedge Claude Code. State-dependent checks fail open; pure
prompt checks that do not need state can still block a dangerous burst.
"""

from __future__ import annotations

import argparse
import contextlib
import contextvars
import datetime as dt
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - these hooks run under Linux/WSL.
    fcntl = None

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python 3.9+ is used in production.
    ZoneInfo = None  # type: ignore[assignment,misc]
    ZoneInfoNotFoundError = KeyError  # type: ignore[misc,assignment]


AGENT_OVERRIDE_MARKER = "[allow-agent-burst]"
USAGE_OVERRIDE_MARKER = "[allow-usage-guard]"

DEFAULT_WINDOW_SECONDS = 10 * 60
MAX_WINDOW_SECONDS = 24 * 60 * 60
DEFAULT_ACTIVE_AGENT_MAX = 4
DEFAULT_PENDING_AGENT_SECONDS = 5 * 60
DEFAULT_ACTIVE_LEASE_SECONDS = 6 * 60 * 60
DEFAULT_KNOWN_AGENT_SECONDS = 30 * 24 * 60 * 60
DEFAULT_COMPACTION_MAX = 10_000
DEFAULT_AGENT_START_MAX = 12
DEFAULT_AGENT_CONTEXT_MAX = 10_000_000
DEFAULT_DORMANT_RESUME_MAX = 1
DEFAULT_DORMANT_SECONDS = 60 * 60
DEFAULT_DORMANT_CONTEXT = 150_000
DEFAULT_CONTEXT_WARN = 300_000
DEFAULT_CONTEXT_HARD = 500_000
DEFAULT_TOOL_CONTEXT = 400_000
DEFAULT_TOOL_MAX = 20
DEFAULT_RESEARCH_CONTEXT = 300_000
DEFAULT_RATE_LIMIT_COOLDOWN = 5 * 60
DEFAULT_SESSION_LIMIT_COOLDOWN = 60 * 60
DEFAULT_MAX_EFFORT_AGE = 60 * 60
DEFAULT_TOOL_FAILURE_MAX = 3
DEFAULT_BLOCK_FUSE_MAX = 5
DEFAULT_BLOCK_FUSE_SECONDS = DEFAULT_WINDOW_SECONDS
DEFAULT_STATE_EVENT_MAX = 10_000
DEFAULT_EVENTS_RETENTION_SECONDS = 365 * 24 * 60 * 60
DEFAULT_EVENTS_MAX = 50_000
MAX_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024

BLOCKED_RULE_PATTERN = re.compile(
    r"agent-usage-guard's\s+([^:]+?):",
    re.IGNORECASE,
)
EVENT_DECISIONS = frozenset(
    {
        "ask",
        "deny",
        "notice",
        "circuit_arm",
        "override_arm",
        "fuse_trip",
    }
)
EVENT_ALLOWED_KEYS = frozenset(
    {
        "at",
        "session_id",
        "mode",
        "decision",
        "rule",
        "attempt",
        "fingerprint",
        "permission_mode",
        "tool_name",
        "context_bucket",
    }
)
CONDITION_SCOPED_RULES = frozenset(
    {
        "high-context turn guard",
        "active-agent guard",
        "rolling agent guard",
        "nested-agent guard",
        "agent-context guard",
    }
)
AGENT_BUDGET_RULES = frozenset(
    {
        "active-agent guard",
        "rolling agent guard",
        "nested-agent guard",
        "agent-context guard",
    }
)
CONTEXT_BUCKETS = (
    (150_000, "<150k"),
    (300_000, "150-300k"),
    (400_000, "300-400k"),
    (500_000, "400-500k"),
)
CONTEXT_BUCKET_ORDER = tuple(label for _ceiling, label in CONTEXT_BUCKETS) + (">=500k",)

_hook_context: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "agent_usage_guard_hook",
    default=None,
)

BROAD_RESUME_PATTERNS = (
    re.compile(
        r"\b(?:resume|continue|restart|wake(?:\s+up)?)\b"
        r".{0,40}\b(?:all|every)\b.{0,24}\b(?:subagents?|agents?|tasks?)\b",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\b(?:all|every)\b.{0,24}\b(?:subagents?|agents?|tasks?)\b"
        r".{0,40}\b(?:resume|continue|restart|wake(?:\s+up)?)\b",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\b(?:spawn|start|launch|create)\b"
        r".{0,40}\b(?:all|every)\b.{0,24}\b(?:subagents?|agents?)\b",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\b(?:all|every)\b.{0,24}\b(?:subagents?|agents?)\b"
        r".{0,40}\b(?:spawn|start|launch|create)\b",
        re.IGNORECASE | re.DOTALL,
    ),
)
RESUME_MESSAGE_PATTERN = re.compile(
    r"\b(?:resume|continue|restart|wake(?:\s+up)?|pick\s+up|"
    r"where\s+you\s+left\s+off|interrupted|finish\s+the\s+(?:full\s+)?scope)\b",
    re.IGNORECASE,
)
NEGATION_PATTERN = re.compile(
    r"(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bavoid\b|\bwithout\b|\bnot\s+to\b)",
    re.IGNORECASE,
)
CLAUSE_BOUNDARY_PATTERN = re.compile(
    r"(?:[;,.!?\n—–]|\b(?:but|however|instead|then)\b)",
    re.IGNORECASE,
)
RECOVERY_COMMAND_PATTERN = re.compile(
    r"^\s*/(?:status|model|compact|clear|context|usage|usage-credits|"
    r"rate-limit-options)\b",
    re.IGNORECASE,
)
RESET_RELATIVE_PATTERN = re.compile(
    r"\bresets?\s+in\s+(\d+)\s*"
    r"(minutes?|mins?|m|hours?|hrs?|h)\b"
    r"(?:\s*(?:and\s*)?(\d+)\s*"
    r"(minutes?|mins?|m|hours?|hrs?|h)\b)?",
    re.IGNORECASE,
)
RESET_CLOCK_PATTERN = re.compile(
    r"\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b"
    r"(?:\s*\(([^)]+)\))?",
    re.IGNORECASE,
)
RESET_WEEKDAY_CLOCK_PATTERN = re.compile(
    r"\bresets?\s+(?:on\s+)?"
    r"(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|"
    r"fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+"
    r"(?:at\s+)?"
    r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b"
    r"(?:\s*\(([^)]+)\))?",
    re.IGNORECASE,
)
RESET_24H_PATTERN = re.compile(
    r"\bresets?(?:\s+at)?\s+(\d{1,2}):(\d{2})\b"
    r"(?!\s*(?:am|pm))"
    r"(?:\s*\(([^)]+)\))?",
    re.IGNORECASE,
)
RESET_WEEKDAY_24H_PATTERN = re.compile(
    r"\bresets?\s+(?:on\s+)?"
    r"(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|"
    r"fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+"
    r"(?:at\s+)?(\d{1,2}):(\d{2})\b"
    r"(?!\s*(?:am|pm))"
    r"(?:\s*\(([^)]+)\))?",
    re.IGNORECASE,
)
# Claude Code offers a model switch only when another model still works, so a
# limit that names it is scoped to one model rather than to the account.
MODEL_SWITCH_REMEDY_PATTERN = re.compile(
    r"(?:/model\b[^.\n]{0,40}\bswitch\b|"
    r"\bswitch(?:ing)?\s+(?:to\s+)?(?:another\s+|a\s+different\s+)?models?\b)",
    re.IGNORECASE,
)
WEEKDAY_INDEX = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}
UNRESERVED_AGENT_TYPES = {"workflow-subagent", "fork"}
DENIAL_KINDS = {"user-rejected", "permission-rule"}


def env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def now_seconds() -> float:
    try:
        value = float(os.environ["AGENT_GUARD_NOW"])
        return value if math.isfinite(value) else time.time()
    except (KeyError, ValueError):
        return time.time()


def enabled() -> bool:
    return os.environ.get("AGENT_GUARD", "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def foreign_host() -> bool:
    """True when a non-Claude agent CLI is running this hook.

    Cursor Agent imports the plugins enabled in ``~/.claude/settings.json`` and
    runs their hooks under its own event names, exporting ``CURSOR_PLUGIN_ROOT``
    beside the ``CLAUDE_PLUGIN_ROOT`` compatibility alias. Everything this guard
    accounts for - context rebuilt, requests spent, agents in flight - is Claude
    session state, so a foreign host would be blocked on another tool's usage
    with no way to act on the advice. Claude Code never sets that variable.
    """
    return bool(os.environ.get("CURSOR_PLUGIN_ROOT", "").strip())


def state_path() -> Path:
    override = os.environ.get("AGENT_GUARD_STATE")
    if override:
        return Path(override).expanduser()
    root = Path(
        os.environ.get(
            "XDG_STATE_HOME",
            str(Path.home() / ".local" / "state"),
        )
    )
    return root / "agent-usage-guard" / "state.json"


def events_enabled() -> bool:
    return os.environ.get("AGENT_GUARD_EVENTS", "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def events_path() -> Path:
    override = os.environ.get("AGENT_GUARD_EVENTS_PATH")
    if override:
        return Path(override).expanduser()
    state = state_path()
    # Canonical installs use state.json → events.jsonl. Tests often place many
    # state files in one temp directory; give those a unique sibling journal so
    # they do not clobber each other.
    if state.name == "state.json":
        return state.with_name("events.jsonl")
    return state.parent / f"{state.stem}.events.jsonl"


def rule_from_message(message: str) -> str:
    matches = list(BLOCKED_RULE_PATTERN.finditer(message))
    if matches:
        return matches[-1].group(1).strip()
    if message.startswith("USAGE GUARD:"):
        return "notice"
    return "unknown"


def decision_for_intervention(base: str, rule: str) -> str:
    if base in EVENT_DECISIONS:
        if base == "deny" and "fuse" in rule.lower():
            return "fuse_trip"
        return base
    if "fuse" in rule.lower():
        return "fuse_trip"
    return "deny"


def bind_hook_context(mode: str, payload: dict[str, Any]) -> contextvars.Token:
    permission = payload.get("permission_mode")
    tool = payload.get("tool_name")
    return _hook_context.set(
        {
            "mode": mode,
            "session_id": session_id(payload),
            "permission_mode": permission if isinstance(permission, str) else None,
            "tool_name": tool if isinstance(tool, str) and tool else None,
        }
    )


def context_bucket(tokens: int) -> str:
    for ceiling, label in CONTEXT_BUCKETS:
        if tokens < ceiling:
            return label
    return ">=500k"


def remember_context(tokens: int) -> None:
    ctx = _hook_context.get()
    if ctx is None:
        return
    ctx["context_bucket"] = context_bucket(tokens)


def record_intervention(
    *,
    decision: str,
    rule: str = "",
    mode: str = "",
    session_id: str = "",
    attempt: int | None = None,
    fingerprint: str | None = None,
    permission_mode: str | None = None,
    message: str = "",
    now: float | None = None,
) -> None:
    """Append one privacy-minimal intervention to the local events journal.

    Fail-open: journal I/O never changes allow/deny behaviour. Records carry
    hashes, ids, timestamps, rule names, tool names, and coarse context
    buckets only — never prompt text, tool inputs, errors, or model output.
    """
    if not events_enabled():
        return
    ctx = _hook_context.get() or {}
    resolved_rule = (rule or rule_from_message(message) or "unknown").strip()
    resolved_decision = decision_for_intervention(decision, resolved_rule)
    stamp = float(now if now is not None else now_seconds())
    event: dict[str, Any] = {
        "at": stamp,
        "session_id": session_id or str(ctx.get("session_id") or ""),
        "mode": mode or str(ctx.get("mode") or ""),
        "decision": resolved_decision,
        "rule": resolved_rule,
    }
    if attempt is not None:
        event["attempt"] = int(attempt)
    if fingerprint:
        event["fingerprint"] = str(fingerprint)
    perm = permission_mode
    if perm is None:
        perm = ctx.get("permission_mode")
    if isinstance(perm, str) and perm:
        event["permission_mode"] = perm
    tool_name = ctx.get("tool_name")
    if isinstance(tool_name, str) and tool_name:
        event["tool_name"] = tool_name
    bucket = ctx.get("context_bucket")
    if isinstance(bucket, str) and bucket:
        event["context_bucket"] = bucket
    # Drop anything outside the public schema before it hits disk.
    event = {key: event[key] for key in EVENT_ALLOWED_KEYS if key in event}
    try:
        _write_event(event, stamp)
    except OSError:
        return


def _read_event_lines(path: Path, cutoff: float) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    if not path.is_file():
        return kept
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            try:
                item = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(item, dict):
                continue
            at = item.get("at")
            if not is_finite_number(at) or float(at) < cutoff:
                continue
            cleaned = {key: item[key] for key in EVENT_ALLOWED_KEYS if key in item}
            if "decision" in cleaned and "rule" in cleaned:
                kept.append(cleaned)
    return kept


def _write_event(event: dict[str, Any], now: float) -> None:
    path = events_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    retention = env_int(
        "AGENT_GUARD_EVENTS_RETENTION_SECONDS",
        DEFAULT_EVENTS_RETENTION_SECONDS,
        1,
    )
    maximum = env_int("AGENT_GUARD_EVENTS_MAX", DEFAULT_EVENTS_MAX, 1)
    cutoff = now - retention
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+b") as lock_handle:
        if fcntl is not None:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            existing = _read_event_lines(path, cutoff)
            existing.append(event)
            if len(existing) > maximum:
                existing = existing[-maximum:]
            fd, tmp_name = tempfile.mkstemp(
                dir=str(path.parent),
                prefix=".events-",
                suffix=".tmp",
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    for item in existing:
                        handle.write(json.dumps(item, separators=(",", ":")) + "\n")
                os.replace(tmp_name, path)
            except Exception:
                with contextlib.suppress(OSError):
                    os.unlink(tmp_name)
                raise
        finally:
            if fcntl is not None:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def load_events(
    *, now: float | None = None, since: float | None = None
) -> list[dict[str, Any]]:
    stamp = float(now if now is not None else now_seconds())
    retention = env_int(
        "AGENT_GUARD_EVENTS_RETENTION_SECONDS",
        DEFAULT_EVENTS_RETENTION_SECONDS,
        1,
    )
    cutoff = stamp - retention
    if since is not None:
        cutoff = max(cutoff, float(since))
    try:
        return _read_event_lines(events_path(), cutoff)
    except OSError:
        return []


def empty_state() -> dict[str, Any]:
    return {
        "version": 5,
        "agent_pending": [],
        "agent_leases": [],
        "agent_history": [],
        "known_agents": [],
        "dormant_resumes": [],
        "usage_events": [],
        "tool_events": [],
        "tool_failures": [],
        "block_events": [],
        "notices": [],
        "agent_overrides": {},
        "usage_overrides": {},
        "agent_fuses": {},
        "compactions": {},
        "rate_limit": None,
    }


def normalize_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return empty_state()
    state = empty_state()
    list_keys = (
        "agent_pending",
        "agent_leases",
        "agent_history",
        "known_agents",
        "dormant_resumes",
        "usage_events",
        "tool_events",
        "tool_failures",
        "block_events",
        "notices",
    )
    for key in list_keys:
        if isinstance(value.get(key), list):
            state[key] = value[key]
    # Version 4 stored unconfirmed PreToolUse reservations in agent_leases and
    # agent_history. Move anonymous entries into the short-lived pending pool;
    # entries already bound to an agent_id are confirmed.
    if value.get("version") == 4:
        pending = [
            dict(item)
            for item in state["agent_leases"]
            if isinstance(item, dict) and not item.get("agent_id")
        ]
        pending_keys = {
            (item.get("session_id"), item.get("tool_use_id")) for item in pending
        }
        state["agent_pending"].extend(pending)
        state["agent_leases"] = [
            item
            for item in state["agent_leases"]
            if not isinstance(item, dict) or item.get("agent_id")
        ]
        state["agent_history"] = [
            item
            for item in state["agent_history"]
            if not isinstance(item, dict)
            or (
                item.get("session_id"),
                item.get("tool_use_id"),
            )
            not in pending_keys
        ]
    # Migrate the first guard version without losing in-flight leases.
    if not state["agent_leases"] and isinstance(value.get("agent_resumes"), list):
        state["agent_leases"] = value["agent_resumes"]
        state["agent_history"] = [
            dict(item) for item in value["agent_resumes"] if isinstance(item, dict)
        ]
        state["known_agents"] = [
            {
                "at": item.get("at"),
                "session_id": item.get("session_id"),
                "target": item.get("target"),
            }
            for item in value["agent_resumes"]
            if isinstance(item, dict) and item.get("target")
        ]
    if value.get("version") != 5 and not state["known_agents"]:
        seen_agents = set()
        for item in state["agent_leases"] + state["agent_history"]:
            if not isinstance(item, dict):
                continue
            stored_sid = item.get("session_id")
            stored_sid = stored_sid if isinstance(stored_sid, str) else ""
            for target in (item.get("target"), item.get("agent_id")):
                if not isinstance(target, str) or not target:
                    continue
                key = (stored_sid, target)
                if key in seen_agents:
                    continue
                seen_agents.add(key)
                state["known_agents"].append(
                    {
                        "at": item.get("at"),
                        "session_id": key[0],
                        "target": key[1],
                    }
                )
    if isinstance(value.get("agent_overrides"), dict):
        state["agent_overrides"] = value["agent_overrides"]
    elif isinstance(value.get("overrides"), dict):
        state["agent_overrides"] = value["overrides"]
    if isinstance(value.get("usage_overrides"), dict):
        state["usage_overrides"] = value["usage_overrides"]
    if isinstance(value.get("agent_fuses"), dict):
        state["agent_fuses"] = value["agent_fuses"]
    if isinstance(value.get("compactions"), dict):
        state["compactions"] = value["compactions"]
    if isinstance(value.get("rate_limit"), dict):
        state["rate_limit"] = value["rate_limit"]
    return state


def is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def prune_timed_items(value: Any, cutoff: float) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        item
        for item in value
        if isinstance(item, dict)
        and is_finite_number(item.get("at"))
        and item["at"] >= cutoff
    ]


def timed_in_window(
    item: dict[str, Any],
    now: float,
    window: int,
) -> bool:
    return bool(
        is_finite_number(item.get("at")) and now - window <= float(item["at"]) <= now
    )


def item_not_expired(
    item: dict[str, Any],
    now: float,
    default_seconds: int,
) -> bool:
    if not is_finite_number(item.get("at")) or float(item["at"]) > now:
        return False
    expiry = item.get("expires_at")
    if is_finite_number(expiry):
        return float(expiry) >= now
    return float(item["at"]) + default_seconds >= now


def prune_expiry_map(value: Any, now: float) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): float(expiry)
        for key, expiry in value.items()
        if is_finite_number(expiry) and expiry >= now
    }


def prune_state(state: dict[str, Any], now: float, window: int) -> None:
    prior_pending_keys = {
        (str(item.get("session_id") or ""), str(item.get("tool_use_id") or ""))
        for item in state.get("agent_pending", [])
        if isinstance(item, dict)
    }
    state["agent_pending"] = [
        item
        for item in state.get("agent_pending", [])
        if isinstance(item, dict)
        and item_not_expired(
            item,
            now,
            DEFAULT_PENDING_AGENT_SECONDS,
        )
    ]
    retained_pending_keys = {
        (str(item.get("session_id") or ""), str(item.get("tool_use_id") or ""))
        for item in state["agent_pending"]
    }
    expired_pending_keys = prior_pending_keys - retained_pending_keys
    state["agent_leases"] = [
        item
        for item in state.get("agent_leases", [])
        if isinstance(item, dict)
        and item_not_expired(
            item,
            now,
            DEFAULT_ACTIVE_LEASE_SECONDS,
        )
    ]
    state["known_agents"] = [
        item
        for item in state.get("known_agents", [])
        if isinstance(item, dict)
        and item_not_expired(
            item,
            now,
            DEFAULT_KNOWN_AGENT_SECONDS,
        )
    ]
    # Rolling records are shared by processes that may use different window
    # settings. New records use the same process-independent maximum horizon,
    # so a short-window caller cannot erase a later long-window caller's
    # evidence. Legacy unstamped records survive until the cardinality cap
    # migrates them out.
    for key in (
        "agent_history",
        "dormant_resumes",
        "usage_events",
        "tool_events",
        "tool_failures",
        "block_events",
        "notices",
    ):
        state[key] = [
            item
            for item in state.get(key, [])
            if isinstance(item, dict)
            and is_finite_number(item.get("at"))
            and float(item["at"]) <= now
            and (
                "retention_until" not in item
                or (
                    is_finite_number(item.get("retention_until"))
                    and float(item["retention_until"]) >= now
                )
            )
        ]
    event_max = DEFAULT_STATE_EVENT_MAX
    state["known_agents"] = state["known_agents"][-event_max:]
    for key in (
        "agent_history",
        "dormant_resumes",
        "usage_events",
        "tool_events",
        "tool_failures",
        "block_events",
        "notices",
    ):
        state[key] = state[key][-event_max:]
    if expired_pending_keys:
        state["tool_events"] = [
            item
            for item in state["tool_events"]
            if (str(item.get("session_id") or ""), str(item.get("id") or ""))
            not in expired_pending_keys
        ]
    state["agent_overrides"] = prune_expiry_map(state.get("agent_overrides"), now)
    state["usage_overrides"] = prune_expiry_map(state.get("usage_overrides"), now)
    state["agent_fuses"] = prune_expiry_map(state.get("agent_fuses"), now)
    compactions = state.get("compactions")
    if isinstance(compactions, dict):
        retained_compactions = {
            str(key): float(value)
            for key, value in compactions.items()
            if is_finite_number(value) and float(value) <= now
        }
        maximum = DEFAULT_COMPACTION_MAX
        state["compactions"] = dict(
            sorted(
                retained_compactions.items(),
                key=lambda item: item[1],
                reverse=True,
            )[:maximum]
        )
    else:
        state["compactions"] = {}
    rate_limit = state.get("rate_limit")
    if not (
        isinstance(rate_limit, dict)
        and is_finite_number(rate_limit.get("until"))
        and rate_limit["until"] > now
    ):
        state["rate_limit"] = None


@contextlib.contextmanager
def locked_state(now: float, window: int) -> Iterator[dict[str, Any]]:
    """Lock, load, prune, and atomically persist shared hook state."""

    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with lock_path.open("a+", encoding="utf-8") as lock:
        if fcntl is not None:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            try:
                state = normalize_state(json.loads(path.read_text(encoding="utf-8")))
            except (
                FileNotFoundError,
                json.JSONDecodeError,
                OSError,
                UnicodeError,
                RecursionError,
            ):
                state = empty_state()
            prune_state(state, now, window)
            reconcile_pending_denials(state)
            yield state
            fd, tmp_name = tempfile.mkstemp(
                prefix=path.name + ".",
                suffix=".tmp",
                dir=path.parent,
                text=True,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as tmp:
                    json.dump(state, tmp, separators=(",", ":"), sort_keys=True)
                    tmp.write("\n")
                    tmp.flush()
                    os.fsync(tmp.fileno())
                os.replace(tmp_name, path)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(tmp_name)
        finally:
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def read_payload() -> dict[str, Any] | None:
    try:
        value = json.load(sys.stdin)
    except (OSError, UnicodeError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def canonical_hash(value: Any) -> str:
    try:
        raw = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
    except (TypeError, ValueError):
        raw = repr(value)
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:24]


def parse_timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        timestamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        return timestamp if math.isfinite(timestamp) else None
    except (OSError, OverflowError, ValueError):
        return None


def session_id(payload: dict[str, Any]) -> str:
    value = payload.get("session_id")
    if isinstance(value, str) and value:
        return value
    path = payload.get("transcript_path")
    return f"path:{canonical_hash(path)}" if isinstance(path, str) and path else ""


def transcript_path(payload: dict[str, Any]) -> Path | None:
    value = payload.get("agent_transcript_path")
    if payload.get("hook_event_name") == "SubagentStop" and not (
        isinstance(value, str) and value
    ):
        # transcript_path on SubagentStop is the parent transcript. Falling
        # back to it would misattribute parent usage to the subagent.
        return None
    if not isinstance(value, str) or not value:
        value = payload.get("transcript_path")
    return Path(value).expanduser() if isinstance(value, str) and value else None


def is_subagent_payload(payload: dict[str, Any]) -> bool:
    agent_id = payload.get("agent_id")
    if isinstance(agent_id, str) and agent_id:
        return True
    path = transcript_path(payload)
    return bool(path and "subagents" in path.parts)


def transcript_tail(path: Path) -> str:
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - MAX_TRANSCRIPT_TAIL_BYTES))
        data = handle.read()
    if size > MAX_TRANSCRIPT_TAIL_BYTES:
        first_newline = data.find(b"\n")
        if first_newline >= 0:
            data = data[first_newline + 1 :]
    return data.decode("utf-8", errors="replace")


def transcript_lines(payload: dict[str, Any]) -> list[str]:
    path = transcript_path(payload)
    if path is None:
        return []
    try:
        return transcript_tail(path).splitlines()
    except OSError:
        return []


def reverse_transcript_lines(path: Path) -> Iterator[bytes]:
    """Yield complete transcript lines newest-first without reading 4 MiB eagerly."""

    block_size = 64 * 1024
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            position = handle.tell()
            scanned = 0
            remainder = b""
            while position > 0 and scanned < MAX_TRANSCRIPT_TAIL_BYTES:
                size = min(block_size, position, MAX_TRANSCRIPT_TAIL_BYTES - scanned)
                position -= size
                handle.seek(position)
                chunk = handle.read(size)
                scanned += len(chunk)
                pieces = (chunk + remainder).split(b"\n")
                remainder = pieces[0]
                for line in reversed(pieces[1:]):
                    if line:
                        yield line
            if position == 0 and remainder:
                yield remainder
    except OSError:
        return


def transcript_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in transcript_lines(payload):
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, RecursionError):
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (OverflowError, TypeError, ValueError):
        return 0


def transcript_requests(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Return privacy-minimal usage data for real model requests."""

    requests = []
    subagent = is_subagent_payload(payload)
    sid = session_id(payload)
    for record in transcript_records(payload):
        request = request_from_record(record, sid, subagent)
        if request is not None:
            requests.append(request)
    return requests


def request_from_record(
    record: dict[str, Any],
    sid: str,
    subagent: bool,
) -> dict[str, Any] | None:
    if record.get("type") != "assistant":
        return None
    message = record.get("message")
    if not isinstance(message, dict) or message.get("model") == "<synthetic>":
        return None
    usage = message.get("usage")
    timestamp = parse_timestamp(record.get("timestamp"))
    if not isinstance(usage, dict) or timestamp is None:
        return None
    context = sum(
        nonnegative_int(usage.get(key))
        for key in (
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        )
    )
    model = message.get("model")
    model = model if isinstance(model, str) else ""
    request_key = record.get("requestId") or message.get("id")
    if not isinstance(request_key, str) or not request_key:
        request_key = canonical_hash([timestamp, model, context, sid])
    return {
        "id": request_key,
        "at": timestamp,
        "context": context,
        "model": model,
        "subagent": subagent,
        "session_id": sid,
    }


def latest_request(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return privacy-minimal usage data for the latest real model request."""

    sid = session_id(payload)
    subagent = is_subagent_payload(payload)
    path = transcript_path(payload)
    if path is None:
        return None
    for line in reverse_transcript_lines(path):
        try:
            record = json.loads(line)
        except (UnicodeError, json.JSONDecodeError, RecursionError):
            continue
        if not isinstance(record, dict):
            continue
        request = request_from_record(record, sid, subagent)
        if request is not None:
            return request
    return None


def message_text(record: dict[str, Any]) -> str:
    message = record.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        )
    return ""


def recently_used_max_effort(
    payload: dict[str, Any],
    now: float,
    max_age: int,
) -> bool:
    """Return whether the most recent in-window effort change selected max."""

    authoritative = payload.get("effort")
    authoritative_level = (
        authoritative.get("level") if isinstance(authoritative, dict) else authoritative
    )
    if isinstance(authoritative_level, str):
        normalized = authoritative_level.lower()
        if normalized in {"low", "medium", "high", "max", "xhigh", "ultracode"}:
            return normalized in {"max", "xhigh", "ultracode"}

    cutoff = now - max_age
    for record in reversed(transcript_records(payload)):
        timestamp = parse_timestamp(record.get("timestamp"))
        if timestamp is not None and timestamp < cutoff:
            break
        record_effort = record.get("effort")
        if isinstance(record_effort, str):
            normalized = record_effort.lower()
            if normalized in {"low", "medium", "high", "max", "xhigh", "ultracode"}:
                return normalized in {"max", "xhigh", "ultracode"}
        text = message_text(record).lower()
        level = re.search(
            r"set effort level to\s+(low|medium|high|max|ultracode)\b",
            text,
        )
        if level:
            return level.group(1) in {"max", "ultracode"}
        if "<command-name>/effort</command-name>" in text and (
            command_level := re.search(
                r"<command-args>\s*(low|medium|high|max|ultracode)\s*</command-args>",
                text,
            )
        ):
            return command_level.group(1) in {"max", "ultracode"}
    return False


def record_usage(
    state: dict[str, Any],
    request: dict[str, Any] | None,
    now: float,
    window: int,
) -> None:
    if request is None or float(request["at"]) < now - window:
        return
    retention_until = float(request["at"]) + MAX_WINDOW_SECONDS
    request_sid = str(request.get("session_id") or "")
    compacted_at = float(state["compactions"].get(request_sid) or 0)
    if (
        request_sid
        and compacted_at
        and not request.get("subagent")
        and float(request["at"]) > compacted_at
    ):
        state["compactions"].pop(request_sid, None)
    existing = next(
        (item for item in state["usage_events"] if item.get("id") == request["id"]),
        None,
    )
    if existing is not None:
        existing["context"] = max(
            nonnegative_int(existing.get("context")),
            nonnegative_int(request["context"]),
        )
        existing["subagent"] = bool(existing.get("subagent")) or bool(
            request["subagent"]
        )
        existing["retention_until"] = max(
            float(existing.get("retention_until") or 0),
            retention_until,
        )
        return
    stored_request = dict(request)
    stored_request["retention_until"] = retention_until
    state["usage_events"].append(stored_request)


def effective_context(
    state: dict[str, Any],
    sid: str,
    request: dict[str, Any] | None,
) -> int:
    if request is not None:
        compacted_at = state["compactions"].get(sid, 0)
        if request["at"] > compacted_at:
            tokens = nonnegative_int(request["context"])
        else:
            tokens = 0
    else:
        candidates = [
            item
            for item in state["usage_events"]
            if item.get("session_id") == sid
            and float(item.get("at") or 0) > state["compactions"].get(sid, 0)
        ]
        if not candidates:
            tokens = 0
        else:
            latest = max(candidates, key=lambda item: float(item.get("at") or 0))
            tokens = nonnegative_int(latest.get("context"))
    remember_context(tokens)
    return tokens


def text_is_negated(text: str, match_start: int) -> bool:
    prefix = text[max(0, match_start - 32) : match_start]
    clause = CLAUSE_BOUNDARY_PATTERN.split(prefix)[-1]
    return bool(NEGATION_PATTERN.search(clause))


def requests_broad_resume(prompt: str) -> bool:
    for pattern in BROAD_RESUME_PATTERNS:
        for match in pattern.finditer(prompt):
            if re.search(r"[;.!?\n]", match.group(0)):
                continue
            if not text_is_negated(prompt, match.start()):
                return True
    return False


def is_resume_message(message: str) -> bool:
    match = RESUME_MESSAGE_PATTERN.search(message)
    return bool(match and not text_is_negated(message, match.start()))


def is_recovery_command(prompt: str) -> bool:
    return bool(RECOVERY_COMMAND_PATTERN.search(prompt))


def has_override_directive(prompt: str, marker: str) -> bool:
    """Require an intentional, standalone first-line override directive."""

    for line in prompt.splitlines():
        stripped = line.strip().lower()
        if not stripped:
            continue
        return stripped == marker
    return False


def near_miss_override(prompt: str) -> str:
    """Return a marker the first line tried to use but placed wrongly.

    ``has_override_directive`` is deliberately strict: the marker must be the
    entire first non-blank line, so quoted, negated, and explanatory mentions
    stay inert. The cost is that ``[allow-usage-guard] continue`` arms nothing
    and looks identical to never having tried, which is how a broken escape
    hatch can go unnoticed indefinitely.

    Only a line that *starts* with a marker counts. An inline mention later in
    the sentence is the case strictness exists to ignore, and warning about it
    would punish the prose the rule was written to allow.
    """
    for line in prompt.splitlines():
        stripped = line.strip().lower()
        if not stripped:
            continue
        for marker in (AGENT_OVERRIDE_MARKER, USAGE_OVERRIDE_MARKER):
            if stripped == marker or not stripped.startswith(marker):
                continue
            # A word character straight after the marker means the line opened
            # on a longer token that merely shares the prefix. Telling its
            # author that their bypass failed to arm is advice about a marker
            # they never used.
            if stripped[len(marker)].isalnum() or stripped[len(marker)] in "-_":
                continue
            return marker
        return ""
    return ""


PLACEMENT_RULE = "alone on the first non-blank line of a prompt"


def marker_directive(marker: str) -> str:
    """Name a marker together with the rule that makes it arm anything.

    ``has_override_directive`` accepts exactly one placement, so a denial that
    advertises a marker without that rule points at the form users reach for
    first - the marker typed ahead of the retry, on the same line - which arms
    nothing. Every message that names a marker states the rule, either through
    here or by ending on ``PLACEMENT_RULE`` where that reads better.
    """
    return f"{marker} {PLACEMENT_RULE}"


def near_miss_hint(marker: str) -> str:
    return (
        f"{marker} did not arm a bypass - it must sit alone on the first "
        "non-blank line, and this prompt put other text on that line."
    )


def tool_fingerprint(tool_name: str, tool_input: dict[str, Any]) -> str:
    return canonical_hash([tool_name, tool_input])


def send_target(tool_input: dict[str, Any]) -> str:
    value = tool_input.get("to") or tool_input.get("recipient")
    return value if isinstance(value, str) else ""


def is_resumable_send(tool_name: str, tool_input: dict[str, Any]) -> bool:
    if tool_name != "SendMessage" or not send_target(tool_input):
        return False
    # Current Claude Code uses structured message objects for shutdown and
    # approval protocols. Only a plain-text message can resume a stopped agent.
    return isinstance(tool_input.get("message"), str)


def agent_entry_matches(item: dict[str, Any], target: str) -> bool:
    return bool(
        target and (target == item.get("target") or target == item.get("agent_id"))
    )


def agent_budget_used(
    state: dict[str, Any],
    now: float,
    window: int,
    *,
    active: bool,
) -> int:
    confirmed = (
        state["agent_leases"]
        if active
        else [
            item
            for item in state["agent_history"]
            if timed_in_window(item, now, window)
        ]
    )
    used = len(state["agent_pending"]) + len(confirmed)
    unmatched_pending_ids = {
        str(item.get("tool_use_id") or "")
        for item in state["agent_pending"]
        if item.get("kind") == "start" and item.get("tool_use_id")
    }
    overlap = 0
    for item in confirmed:
        if not item.get("ambiguous_pending"):
            continue
        candidate_ids = item.get("ambiguous_tool_ids")
        if not isinstance(candidate_ids, list):
            continue
        matches = unmatched_pending_ids.intersection(
            str(value) for value in candidate_ids
        )
        if matches:
            unmatched_pending_ids.remove(next(iter(matches)))
            overlap += 1
    return max(0, used - overlap)


def remember_agent(
    state: dict[str, Any],
    sid: str,
    target: Any,
    now: float,
) -> None:
    if not isinstance(target, str) or not target:
        return
    known = next(
        (
            item
            for item in state["known_agents"]
            if item.get("target") == target and item.get("session_id") == sid
        ),
        None,
    )
    if known is not None:
        known["at"] = now
        known["expires_at"] = now + env_int(
            "AGENT_GUARD_KNOWN_AGENT_SECONDS",
            DEFAULT_KNOWN_AGENT_SECONDS,
            1,
        )
    else:
        state["known_agents"].append(
            {
                "at": now,
                "expires_at": now
                + env_int(
                    "AGENT_GUARD_KNOWN_AGENT_SECONDS",
                    DEFAULT_KNOWN_AGENT_SECONDS,
                    1,
                ),
                "session_id": sid,
                "target": target,
            }
        )


def bind_agent_alias(
    state: dict[str, Any],
    sid: str,
    alias: Any,
    agent_id: str,
    now: float,
) -> None:
    if not isinstance(alias, str) or not alias or not agent_id:
        return
    remember_agent(state, sid, alias, now)
    for item in state["known_agents"]:
        if item.get("session_id") == sid and item.get("target") == alias:
            item["agent_id"] = agent_id


def release_agent_attempt(
    state: dict[str, Any],
    sid: str,
    tool_id: str,
    *,
    release_history: bool = False,
) -> None:
    if not tool_id:
        return
    state["agent_pending"] = [
        item
        for item in state["agent_pending"]
        if not (item.get("tool_use_id") == tool_id and item.get("session_id") == sid)
    ]
    state["agent_leases"] = [
        item
        for item in state["agent_leases"]
        if not (item.get("tool_use_id") == tool_id and item.get("session_id") == sid)
    ]
    if release_history:
        state["agent_history"] = [
            item
            for item in state["agent_history"]
            if not (
                item.get("tool_use_id") == tool_id and item.get("session_id") == sid
            )
        ]
        state["tool_events"] = [
            item
            for item in state["tool_events"]
            if not (item.get("id") == tool_id and item.get("session_id") == sid)
        ]


def release_pending_attempt(
    state: dict[str, Any],
    sid: str,
    tool_id: str,
    *,
    release_tool_event: bool = False,
) -> None:
    state["agent_pending"] = [
        item
        for item in state["agent_pending"]
        if not (item.get("tool_use_id") == tool_id and item.get("session_id") == sid)
    ]
    if release_tool_event:
        state["tool_events"] = [
            item
            for item in state["tool_events"]
            if not (item.get("id") == tool_id and item.get("session_id") == sid)
        ]


def terminalize_agent_attempt(
    state: dict[str, Any],
    sid: str,
    tool_id: str,
    now: float,
    window: int,
    source: str,
) -> None:
    if not tool_id:
        return
    attempt = next(
        (
            item
            for item in state["agent_pending"] + state["agent_leases"]
            if item.get("tool_use_id") == tool_id and item.get("session_id") == sid
        ),
        None,
    )
    already_historical = any(
        item.get("tool_use_id") == tool_id and item.get("session_id") == sid
        for item in state["agent_history"]
    )
    if attempt is not None and not already_historical:
        historical = {
            key: value
            for key, value in attempt.items()
            if key not in {"expires_at", "offset", "transcript_path"}
        }
        historical["at"] = now
        historical["retention_until"] = now + MAX_WINDOW_SECONDS
        historical["source"] = source
        state["agent_history"].append(historical)
    release_agent_attempt(state, sid, tool_id)


def transcript_offset(payload: dict[str, Any]) -> tuple[str, int]:
    path = transcript_path(payload)
    if path is None:
        return "", 0
    try:
        return str(path), max(0, path.stat().st_size)
    except OSError:
        return str(path), 0


def denial_ids_after(path_value: Any, offset_value: Any) -> set[str]:
    if not isinstance(path_value, str) or not path_value:
        return set()
    try:
        offset = max(0, int(offset_value or 0))
    except (OverflowError, TypeError, ValueError):
        offset = 0
    denied: set[str] = set()
    try:
        with Path(path_value).expanduser().open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(min(offset, size))
            for raw_line in handle:
                try:
                    record = json.loads(raw_line)
                except (UnicodeError, json.JSONDecodeError, RecursionError):
                    continue
                if not isinstance(record, dict) or record.get("type") != "user":
                    continue
                record_denial_kind = record.get("toolDenialKind")
                message = record.get("message")
                content = message.get("content") if isinstance(message, dict) else None
                if not isinstance(content, list):
                    continue
                for item in content:
                    if (
                        isinstance(item, dict)
                        and item.get("type") == "tool_result"
                        and (
                            item.get("toolDenialKind") in DENIAL_KINDS
                            or record_denial_kind in DENIAL_KINDS
                        )
                        and isinstance(item.get("tool_use_id"), str)
                    ):
                        denied.add(item["tool_use_id"])
    except OSError:
        return set()
    return denied


def reconcile_pending_denials(state: dict[str, Any]) -> None:
    """Remove reservations denied without a PermissionDenied hook event."""

    denied_by_source: dict[tuple[str, int], set[str]] = {}
    denied_keys: set[tuple[str, str]] = set()
    for item in state["agent_pending"]:
        try:
            offset = max(0, int(item.get("offset") or 0))
        except (OverflowError, TypeError, ValueError):
            offset = 0
        source = (str(item.get("transcript_path") or ""), offset)
        if source not in denied_by_source:
            denied_by_source[source] = denial_ids_after(*source)
        tool_id = item.get("tool_use_id")
        sid = item.get("session_id")
        if isinstance(tool_id, str) and tool_id in denied_by_source[source]:
            denied_keys.add((str(sid or ""), tool_id))
    if not denied_keys:
        return
    state["agent_pending"] = [
        item
        for item in state["agent_pending"]
        if (str(item.get("session_id") or ""), str(item.get("tool_use_id") or ""))
        not in denied_keys
    ]
    state["tool_events"] = [
        item
        for item in state["tool_events"]
        if (str(item.get("session_id") or ""), str(item.get("id") or ""))
        not in denied_keys
    ]


def agent_override_active(state: dict[str, Any], sid: str, now: float) -> bool:
    return bool(sid and state["agent_overrides"].get(sid, 0) >= now)


def usage_override_active(state: dict[str, Any], sid: str, now: float) -> bool:
    return bool(sid and state["usage_overrides"].get(sid, 0) >= now)


def active_rate_limit(state: dict[str, Any], now: float) -> dict[str, Any] | None:
    value = state.get("rate_limit")
    if (
        isinstance(value, dict)
        and is_finite_number(value.get("until"))
        and value["until"] > now
    ):
        return value
    return None


def add_notice(
    state: dict[str, Any],
    notice_key: str,
    now: float,
    window: int,
) -> bool:
    if any(
        item.get("key") == notice_key and timed_in_window(item, now, window)
        for item in state["notices"]
    ):
        return False
    state["notices"].append(
        {
            "key": notice_key,
            "at": now,
            "retention_until": now + MAX_WINDOW_SECONDS,
        }
    )
    return True


def block(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


def block_prompt(message: str, *, rule: str = "", now: float | None = None) -> int:
    """Deny a prompt-side event without Claude Code's ``[command]: `` prefix.

    A bare exit 2 makes Claude Code render the configured hook command ahead of
    the reason, which for a plugin install is the literal, unexpanded
    ``${CLAUDE_PLUGIN_ROOT}/agent-usage-guard.py`` - noise that reads as a
    broken path. A decision document supplies the reason verbatim instead.

    The exit code deliberately stays 2. Claude Code parses hook stdout before it
    inspects the status, so the document wins today; if that ever stops being
    true the status still denies the event and only the prefix comes back.

    ``PreToolUse`` deliberately keeps the plain path for now. Its denials are
    equivalent under test - neither form emits ``PermissionDenied`` - but the
    two-phase reservation accounting has not been exercised against a decision
    document, so that move belongs in its own change.
    """
    record_intervention(
        decision="deny",
        rule=rule,
        message=message,
        now=now,
    )
    print(
        json.dumps(
            {"decision": "block", "reason": message},
            separators=(",", ":"),
        )
    )
    return block(message)


def block_tool(
    message: str,
    *,
    rule: str = "",
    attempt: int | None = None,
    fingerprint: str | None = None,
    now: float | None = None,
) -> int:
    """Deny a tool call without Claude Code's ``[command]: `` prefix.

    Same rationale as :func:`block_prompt`, using the ``PreToolUse`` decision
    shape. A denial reason that opens with the hook's own command line is worse
    here than on a prompt: the reason is fed to the model, so every agent-budget
    denial spent that prefix on context the model has to read past.

    A live A/B against Claude Code 2.1.220 found the two forms equivalent. Both
    deny the call, both surface the reason to the model, both record the call in
    ``permission_denials``, and neither emits ``PermissionDenied`` - so the
    two-phase reservation accounting behaves identically either way.
    """
    record_intervention(
        decision="deny",
        rule=rule,
        message=message,
        attempt=attempt,
        fingerprint=fingerprint,
        now=now,
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": message,
                }
            },
            separators=(",", ":"),
        )
    )
    return block(message)


#: Permission modes that suppress the dialog a ``PreToolUse`` ask depends on.
#: ``bypassPermissions`` approves everything and ``dontAsk`` is defined by not
#: asking, so an escalation raised in either would be answered without ever
#: reaching the user. The remaining modes still prompt for tool calls.
SILENT_PERMISSION_MODES = frozenset({"bypassPermissions", "dontAsk"})


def prompts_the_user(payload: dict[str, Any]) -> bool:
    """Report whether this session would actually show a permission dialog.

    Escalating into a mode that never prompts would be strictly worse than
    denying: the call is auto-approved and the guard silently stops enforcing.
    A payload with no ``permission_mode`` is treated as prompting, because the
    field is documented as absent on some events and the escalation is the
    intended behaviour.
    """
    return payload.get("permission_mode") not in SILENT_PERMISSION_MODES


def ask_tool(
    message: str,
    *,
    rule: str = "",
    attempt: int | None = None,
    fingerprint: str | None = None,
    now: float | None = None,
) -> int:
    """Escalate a tool call to the user instead of denying it outright.

    ``UserPromptSubmit`` has no interactive decision, so prompt-side guards stay
    hard blocks. ``PreToolUse`` does: ``permissionDecision: "ask"`` renders Claude
    Code's own permission dialog, which turns a denial the user had to answer by
    typing an escape marker into a single keystroke.

    The exit status is 0, not 2. A 2 denies the call outright and would override
    the dialog, so the decision document has to be the only signal here.

    Escalating splits a decision that used to be atomic. ``block_tool`` knew the
    call was refused and could record the refusal inline; an ask does not know
    the outcome yet, so the caller records the reservation optimistically and
    :func:`permission_denied` unwinds it - and records the refusal - if the user
    says no.
    """
    record_intervention(
        decision="ask",
        rule=rule,
        message=message,
        attempt=attempt,
        fingerprint=fingerprint,
        now=now,
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": message,
                }
            },
            separators=(",", ":"),
        )
    )
    return 0


def add_context(
    event_name: str,
    message: str,
    *,
    rule: str = "",
    now: float | None = None,
) -> int:
    record_intervention(
        decision="notice",
        rule=rule or "notice",
        message=message,
        now=now,
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "additionalContext": message,
                }
            },
            separators=(",", ":"),
        )
    )
    return 0


def format_until(until: float) -> str:
    try:
        value = dt.datetime.fromtimestamp(until).astimezone()
        return value.strftime("%I:%M%p %Z on %d %b").lstrip("0")
    except (OSError, OverflowError, ValueError):
        return str(until)


def format_clock(now: float) -> str:
    try:
        return dt.datetime.fromtimestamp(now).astimezone().strftime("%H:%M:%S")
    except (OSError, OverflowError, ValueError):
        return str(now)


def plural(count: int, singular: str, many: str) -> str:
    """Render a count against a phrase that agrees with it.

    Every threshold here is env-tunable down to 1, so a hard-coded plural reads
    as a bug in the denial the model and the user both see. The phrase carries
    the verb too, because "1 agent is" needs more than a dropped "s".
    """
    return f"{count} {singular if count == 1 else many}"


def format_duration(seconds: int) -> str:
    if seconds % 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    minutes = seconds // 60
    return f"{minutes} minute{'s' if minutes != 1 else ''}"


def ladder_message(
    base: str,
    attempt: int,
    now: float,
    is_agent_action: bool,
    fuse_max: int,
    *,
    condition_scoped: bool = False,
) -> str:
    """Rewrite a repeated denial so no two block messages are byte-identical.

    Identical repeated feedback makes model retry loops deterministic; the
    attempt number, wall clock, and escalating instructions give the model new
    information each time. Wording stays factual rather than imperative:
    system-command-style hook text can trip prompt-injection defenses and get
    shown to the user instead of steering the model.
    """

    clock = format_clock(now)
    target = "this condition" if condition_scoped else "this exact call"
    retry = (
        "another call while the condition holds"
        if condition_scoped
        else "an identical retry"
    )
    if attempt <= 1:
        # Naming the alternatives here, not only at denial 2, is a deliberate
        # trade: a handful of extra tokens against a retry that re-sends the
        # entire conversation. Transcript analysis put the identical-retry rate
        # near 44%, with escalation dropping sharply at the first rung that
        # offers a way forward.
        return (
            f"{base} [denial 1 of {target} at {clock}; it stays denied "
            f"while the condition holds, so {retry} fails again. "
            "Alternatives that work: proceed without this call, pick other "
            "work, or report back]"
        )
    if attempt == 2:
        retry_fail = (
            "another call while the condition holds keeps failing"
            if condition_scoped
            else "re-issuing the identical call keeps failing"
        )
        return (
            f"BLOCKED again by agent-usage-guard (denial 2 of {target} "
            f"at {clock}): the blocking condition is unchanged, so "
            f"{retry_fail}. Do something different: "
            "proceed without this call, pick other work, or stop and report. "
            f"Original reason: {base}"
        )
    warning = ""
    if is_agent_action and attempt == fuse_max - 1:
        fuse_seconds = env_int(
            "AGENT_GUARD_BLOCK_FUSE_SECONDS",
            DEFAULT_BLOCK_FUSE_SECONDS,
            1,
        )
        next_attempt = (
            "attempt while the condition holds"
            if condition_scoped
            else "identical attempt"
        )
        warning = (
            f" One more {next_attempt} trips the session-wide agent fuse "
            f"for {format_duration(fuse_seconds)}."
        )
    return (
        f"BLOCKED again by agent-usage-guard (denial {attempt} of {target} "
        f"at {clock}): retrying is not succeeding, and every retry "
        "re-sends the full conversation context. End the turn now with a "
        f"one-line checkpoint of what remains.{warning} "
        f"Original reason: {base}"
    )


def fuse_trip_message(
    attempt: int,
    now: float,
    until: float,
    window: int,
    *,
    condition_scoped: bool = False,
) -> str:
    target = "the same condition" if condition_scoped else "the same call"
    return (
        "BLOCKED by agent-usage-guard's agent fuse: "
        f"{attempt} denials of {target} within {format_duration(window)} "
        f"tripped the session-wide agent fuse at {format_clock(now)}. "
        "Agent starts and resumes in this session are denied until "
        f"{format_until(until)}. End the turn with a checkpoint; do not retry "
        f"agent calls. {marker_directive(USAGE_OVERRIDE_MARKER)} lifts the "
        "fuse only for a deliberate bypass."
    )


def fuse_active_message(attempt: int, now: float, until: float) -> str:
    return (
        "BLOCKED by agent-usage-guard's agent fuse (denial "
        f"{attempt} at {format_clock(now)}): agent starts and resumes in this "
        f"session stay denied until {format_until(until)}. End the turn with "
        f"a checkpoint instead of retrying. "
        f"{marker_directive(USAGE_OVERRIDE_MARKER)} lifts the fuse only for a "
        "deliberate bypass."
    )


def append_block_event(
    state: dict[str, Any],
    *,
    sid: str,
    fingerprint: str,
    now: float,
    rule: str = "",
) -> None:
    event: dict[str, Any] = {
        "at": now,
        "retention_until": now + MAX_WINDOW_SECONDS,
        "session_id": sid,
        "fingerprint": fingerprint,
    }
    if rule:
        event["rule"] = rule
    state.setdefault("block_events", []).append(event)


def ladder_attempt(
    state: dict[str, Any],
    sid: str,
    fingerprint: str,
    rule: str,
    now: float,
    window: int,
) -> int:
    scoped = rule in CONDITION_SCOPED_RULES
    matches = 0
    for item in state.get("block_events", []):
        if item.get("session_id") != sid:
            continue
        if not timed_in_window(item, now, window):
            continue
        if scoped and item.get("rule") == rule:
            matches += 1
            continue
        if item.get("fingerprint") == fingerprint:
            matches += 1
    return 1 + matches


def rate_limit_message(rate_limit: dict[str, Any]) -> str:
    until = float(rate_limit["until"])
    category = str(rate_limit.get("category") or "rate")
    return (
        "BLOCKED by agent-usage-guard's usage circuit breaker: a "
        f"{category} limit is active until {format_until(until)}. "
        "Do not retry agents or prompts before reset. Recovery commands "
        "(/status, /model, /compact, /clear, /context, /usage) remain allowed. "
        f"Use {USAGE_OVERRIDE_MARKER} only for a deliberate bypass, "
        f"{PLACEMENT_RULE}."
    )


def parse_reset_until(text: str, now: float) -> float | None:
    relative = RESET_RELATIVE_PATTERN.search(text)
    if relative:
        seconds = 0
        for amount_group, unit_group in ((1, 2), (3, 4)):
            if relative.group(amount_group) is None:
                continue
            amount = int(relative.group(amount_group))
            unit = relative.group(unit_group).lower()
            seconds += amount * (3600 if unit.startswith("h") else 60)
        return now + seconds

    weekday_clock = RESET_WEEKDAY_CLOCK_PATTERN.search(text)
    weekday_24h = RESET_WEEKDAY_24H_PATTERN.search(text)
    clock = RESET_CLOCK_PATTERN.search(text)
    clock_24h = RESET_24H_PATTERN.search(text)
    if weekday_clock:
        weekday_name = weekday_clock.group(1).lower()[:3]
        hour = int(weekday_clock.group(2))
        minute = int(weekday_clock.group(3) or 0)
        meridiem = weekday_clock.group(4)
        zone_name = weekday_clock.group(5)
    elif weekday_24h:
        weekday_name = weekday_24h.group(1).lower()[:3]
        hour = int(weekday_24h.group(2))
        minute = int(weekday_24h.group(3))
        meridiem = ""
        zone_name = weekday_24h.group(4)
    elif clock:
        weekday_name = ""
        hour = int(clock.group(1))
        minute = int(clock.group(2) or 0)
        meridiem = clock.group(3)
        zone_name = clock.group(4)
    elif clock_24h:
        weekday_name = ""
        hour = int(clock_24h.group(1))
        minute = int(clock_24h.group(2))
        meridiem = ""
        zone_name = clock_24h.group(3)
    else:
        return None
    if hour > (12 if meridiem else 23) or minute > 59:
        return None
    if meridiem.lower() == "pm" and hour != 12:
        hour += 12
    if meridiem.lower() == "am" and hour == 12:
        hour = 0

    zone = None
    if zone_name and ZoneInfo is not None:
        try:
            zone = ZoneInfo(zone_name)
        except (ZoneInfoNotFoundError, ValueError):
            zone = None
    local_now = dt.datetime.fromtimestamp(now, zone)
    candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if weekday_name:
        candidate += dt.timedelta(
            days=(WEEKDAY_INDEX[weekday_name] - local_now.weekday()) % 7
        )
        if candidate.timestamp() <= now:
            candidate += dt.timedelta(days=7)
    elif candidate.timestamp() <= now:
        candidate += dt.timedelta(days=1)
    return candidate.timestamp()


def prompt_guard(payload: dict[str, Any], now: float, window: int) -> int:
    prompt = payload.get("prompt")
    prompt = prompt if isinstance(prompt, str) else ""
    sid = session_id(payload)
    request = latest_request(payload)
    recovery = is_recovery_command(prompt)
    # Notices accumulate rather than occupying one slot. A single slot silently
    # dropped whichever notice lost the race, and the loser was usually the one
    # that mattered: an armed bypass arms in state regardless, so overwriting
    # its confirmation leaves no way to tell it apart from a marker that did
    # nothing at all.
    notices: list[str] = []
    near_miss = near_miss_override(prompt)
    hint = f" Note: {near_miss_hint(near_miss)}" if near_miss else ""
    agent_directive = has_override_directive(prompt, AGENT_OVERRIDE_MARKER)
    usage_directive = has_override_directive(prompt, USAGE_OVERRIDE_MARKER)

    try:
        with locked_state(now, window) as state:
            if agent_directive and sid:
                state["agent_overrides"][sid] = now + window
                record_intervention(
                    decision="override_arm",
                    rule="agent-bypass",
                    now=now,
                )
                notices.append(
                    "The agent-only bypass is active for "
                    f"{format_duration(window)} in this session."
                )
            if usage_directive and sid:
                state["usage_overrides"][sid] = now + window
                record_intervention(
                    decision="override_arm",
                    rule="usage-bypass",
                    now=now,
                )
                notices.append(
                    "The full usage bypass is active for "
                    f"{format_duration(window)} in this session."
                )
            agent_bypass = agent_override_active(state, sid, now)
            usage_bypass = usage_override_active(state, sid, now)
            record_usage(state, request, now, window)

            rate_limit = active_rate_limit(state, now)
            if rate_limit and not recovery and not usage_bypass:
                return block_prompt(rate_limit_message(rate_limit) + hint)

            context = effective_context(state, sid, request)
            hard_context = env_int(
                "AGENT_GUARD_CONTEXT_HARD",
                DEFAULT_CONTEXT_HARD,
                1,
            )
            if context >= hard_context and not recovery and not usage_bypass:
                return block_prompt(
                    "BLOCKED by agent-usage-guard's context guard: this session is carrying "
                    f"roughly {context:,} context tokens. Run /compact or /clear "
                    "before submitting more work. /status, /model, /context and "
                    f"/usage are also allowed. Use {USAGE_OVERRIDE_MARKER} only "
                    f"for a deliberate high-context turn, {PLACEMENT_RULE}." + hint
                )

            if requests_broad_resume(prompt) and not (agent_bypass or usage_bypass):
                return block_prompt(
                    "BLOCKED by agent-usage-guard's agent-burst guard: this prompt would "
                    "start or resume all saved agents at once. Name at most four "
                    "agents and work in batches. "
                    f"Use {AGENT_OVERRIDE_MARKER} only for an intentional "
                    f"burst, {PLACEMENT_RULE}." + hint
                )

            if recovery:
                return 0

            dormant_seconds = env_int(
                "AGENT_GUARD_DORMANT_SECONDS",
                DEFAULT_DORMANT_SECONDS,
                1,
            )
            dormant_context = env_int(
                "AGENT_GUARD_HIGH_CONTEXT_TOKENS",
                DEFAULT_DORMANT_CONTEXT,
                1,
            )
            if (
                request is not None
                and context >= dormant_context
                and now - request["at"] >= dormant_seconds
                and not usage_bypass
            ):
                existing = next(
                    (
                        item
                        for item in state["dormant_resumes"]
                        if sid
                        and item.get("session_id") == sid
                        and timed_in_window(item, now, window)
                    ),
                    None,
                )
                maximum = env_int(
                    "AGENT_GUARD_DORMANT_MAX",
                    DEFAULT_DORMANT_RESUME_MAX,
                    1,
                )
                recent_dormant = sum(
                    timed_in_window(item, now, window)
                    for item in state["dormant_resumes"]
                )
                if existing is None and recent_dormant >= maximum:
                    return block_prompt(
                        "BLOCKED by agent-usage-guard's dormant-session guard: another "
                        "high-context session was resumed in the last "
                        f"{format_duration(window)}. This session would rebuild "
                        f"roughly {context:,} context tokens. Wait, run /compact, "
                        "or deliberately bypass with "
                        f"{marker_directive(USAGE_OVERRIDE_MARKER)}." + hint
                    )
                if existing is None:
                    state["dormant_resumes"].append(
                        {
                            "at": now,
                            "retention_until": now + MAX_WINDOW_SECONDS,
                            "session_id": sid,
                            "context_tokens": context,
                        }
                    )

            warn_context = env_int(
                "AGENT_GUARD_CONTEXT_WARN",
                DEFAULT_CONTEXT_WARN,
                1,
            )
            if context >= warn_context and not usage_bypass:
                notice_key = canonical_hash(["context-warning", sid])
                if add_notice(state, notice_key, now, window):
                    notices.append(
                        f"This session is carrying about {context:,} context "
                        "tokens. Keep this turn bounded, avoid broad fan-out, "
                        "and recommend /compact before the next task."
                    )
    except OSError:
        # Static prompt checks still protect against the most dangerous command
        # even if shared state is temporarily unavailable.
        if requests_broad_resume(prompt) and not has_override_directive(
            prompt,
            AGENT_OVERRIDE_MARKER,
        ):
            return block_prompt(
                "BLOCKED by agent-usage-guard's agent-burst guard: resume named agents in "
                "small batches instead of resuming all agents." + hint
            )
        return 0

    if near_miss:
        notices.append(near_miss_hint(near_miss))
    if notices:
        return add_context("UserPromptSubmit", "USAGE GUARD: " + " ".join(notices))
    return 0


def prompt_expansion_guard(
    payload: dict[str, Any],
    now: float,
    window: int,
) -> int:
    command_name = payload.get("command_name")
    if not isinstance(command_name, str):
        return 0
    command_name = command_name.lower()
    if command_name not in {"research", "deep-research"}:
        return 0
    sid = session_id(payload)
    request = latest_request(payload)
    max_effort = recently_used_max_effort(
        payload,
        now,
        env_int(
            "AGENT_GUARD_MAX_EFFORT_AGE",
            DEFAULT_MAX_EFFORT_AGE,
            1,
        ),
    )
    emit_notice = False
    try:
        with locked_state(now, window) as state:
            usage_bypass = usage_override_active(state, sid, now)
            agent_bypass = agent_override_active(state, sid, now)
            record_usage(state, request, now, window)
            rate_limit = active_rate_limit(state, now)
            if rate_limit and not usage_bypass:
                return block_prompt(rate_limit_message(rate_limit))

            if command_name == "deep-research" and not (agent_bypass or usage_bypass):
                return block_prompt(
                    "BLOCKED by agent-usage-guard's Workflow guard: "
                    "/deep-research runs as an opaque Workflow that can launch "
                    "agents before lifecycle hooks can enforce a budget. Use "
                    "bounded Agent calls instead, or place "
                    f"{marker_directive(AGENT_OVERRIDE_MARKER)} for a "
                    "deliberate run."
                )

            context = effective_context(state, sid, request)
            research_context = env_int(
                "AGENT_GUARD_RESEARCH_CONTEXT",
                DEFAULT_RESEARCH_CONTEXT,
                1,
            )
            if context >= research_context and not usage_bypass:
                return block_prompt(
                    "BLOCKED by agent-usage-guard's research guard: /research would begin at "
                    f"roughly {context:,} context tokens. Run /compact first, "
                    "or deliberately bypass with "
                    f"{marker_directive(USAGE_OVERRIDE_MARKER)}."
                )
            if max_effort and not usage_bypass:
                return block_prompt(
                    "BLOCKED by agent-usage-guard's research guard: maximum effort combined "
                    "with parallel research caused the largest historical agent "
                    "swarm. Lower the effort level before /research, or use "
                    f"{marker_directive(USAGE_OVERRIDE_MARKER)} deliberately."
                )

            rolling_max = env_int(
                "AGENT_GUARD_ROLLING_MAX",
                DEFAULT_AGENT_START_MAX,
                1,
            )
            active_max = env_int(
                "AGENT_GUARD_AGENT_MAX",
                DEFAULT_ACTIVE_AGENT_MAX,
                1,
            )
            near_limit = max(1, rolling_max - 2)
            if (
                agent_budget_used(
                    state,
                    now,
                    window,
                    active=False,
                )
                >= near_limit
            ) and not (agent_bypass or usage_bypass):
                return block_prompt(
                    "BLOCKED by agent-usage-guard's research guard: the rolling agent budget "
                    "is already near its limit. Wait for the "
                    f"{format_duration(window)} window to clear before "
                    "starting another research fan-out."
                )

            notice_key = canonical_hash(
                [
                    "research-budget",
                    sid,
                    request["id"] if request else payload.get("prompt"),
                ]
            )
            emit_notice = add_notice(state, notice_key, now, window)
    except OSError:
        return 0

    if emit_notice:
        if command_name == "deep-research":
            return add_context(
                "UserPromptExpansion",
                "USAGE GUARD: /deep-research was explicitly bypassed. Its "
                "Workflow children cannot be pre-gated individually; observed "
                "starts still count against later rolling and active budgets.",
            )
        return add_context(
            "UserPromptExpansion",
            "USAGE GUARD FOR /research: use at most "
            f"{plural(rolling_max, 'total leaf agent', 'total leaf agents')} in "
            f"{format_duration(window)} and at most {active_max} "
            "concurrently. Agents must not spawn other agents. Work in bounded "
            "batches and stop when the budget is reached; the hook enforces "
            "these limits.",
        )
    return 0


def pre_tool_guard(payload: dict[str, Any], now: float, window: int) -> int:
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        return 0
    sid = session_id(payload)
    supplied_tool_id = payload.get("tool_use_id")
    tool_id = (
        supplied_tool_id
        if isinstance(supplied_tool_id, str) and supplied_tool_id
        else canonical_hash([sid, tool_name, tool_input, int(now)])
    )

    request = latest_request(payload)
    fingerprint = tool_fingerprint(tool_name, tool_input)
    target = send_target(tool_input)
    is_workflow = tool_name == "Workflow"
    is_direct_agent_action = tool_name in {
        "Agent",
        "Task",
    } or is_resumable_send(
        tool_name,
        tool_input,
    )
    is_agent_risk = is_workflow or is_direct_agent_action
    block_reason = ""
    hard_deny = False
    known_target_agent_id = ""
    duplicate_pending_target = False
    attempt = 1

    try:
        with locked_state(now, window) as state:
            # A concurrent duplicate may have won the first lock.
            if any(
                item.get("id") == tool_id and item.get("session_id") == sid
                for item in state["tool_events"]
            ):
                return 0

            if tool_name == "SendMessage" and is_direct_agent_action:
                known_entry = next(
                    (
                        item
                        for item in state["known_agents"]
                        if item.get("target") == target
                        and item.get("session_id") == sid
                    ),
                    None,
                )
                target_is_known = known_entry is not None
                if known_entry is not None and isinstance(
                    known_entry.get("agent_id"),
                    str,
                ):
                    known_target_agent_id = known_entry["agent_id"]
                # A message to an agent with a live lease is a mid-run course
                # correction, not a resume that consumes another slot.
                target_is_active = any(
                    (
                        agent_entry_matches(item, target)
                        or (
                            known_target_agent_id
                            and agent_entry_matches(item, known_target_agent_id)
                        )
                    )
                    and item.get("session_id") == sid
                    for item in state["agent_leases"]
                )
                is_direct_agent_action = not target_is_active and target_is_known
                is_agent_risk = is_direct_agent_action
                duplicate_pending_target = is_direct_agent_action and any(
                    (
                        agent_entry_matches(item, target)
                        or (
                            known_target_agent_id
                            and agent_entry_matches(item, known_target_agent_id)
                        )
                    )
                    and item.get("session_id") == sid
                    for item in state["agent_pending"]
                )

            record_usage(state, request, now, window)
            usage_bypass = usage_override_active(state, sid, now)
            agent_bypass = agent_override_active(state, sid, now)

            # Refusing a guard-raised dialog emits no PermissionDenied - verified
            # live against Claude Code 2.1.220 for both "No" and Esc - so the
            # refusal has to be inferred instead of observed. An escalated
            # reservation still sitting unresolved when the identical call comes
            # back was refused: an approved one would have been confirmed into a
            # lease by SubagentStart or PostToolUse, and the model cannot
            # re-propose the call while its own dialog is still open.
            #
            # Agent-budget rules are conditions on the session, not on one
            # prompt, so a refused 5th agent then a different 5th is still the
            # same ladder. Approval is observable there (PostToolUse /
            # SubagentStart clears the pending), so matching those reservations
            # by rule is safe. High-context and other non-agent asks stay on
            # fingerprint: PostToolUse is only wired for Agent|Task|SendMessage,
            # and matching those by rule would charge a refusal to a call the
            # user allowed.
            stale_refusals: list[tuple[str, str, str]] = []
            seen_stale: set[str] = set()
            for item in state["agent_pending"]:
                if not item.get("escalated") or item.get("session_id") != sid:
                    continue
                stale_id = str(item.get("tool_use_id") or "")
                if not stale_id or stale_id == tool_id or stale_id in seen_stale:
                    continue
                same_call = item.get("fingerprint") == fingerprint
                budget_retry = (
                    is_direct_agent_action
                    and str(item.get("rule") or "") in AGENT_BUDGET_RULES
                )
                if not (same_call or budget_retry):
                    continue
                seen_stale.add(stale_id)
                stale_refusals.append(
                    (
                        stale_id,
                        str(item.get("fingerprint") or fingerprint),
                        str(item.get("rule") or ""),
                    )
                )
            for item in state["tool_events"]:
                if not (
                    item.get("escalated")
                    and item.get("session_id") == sid
                    and item.get("fingerprint") == fingerprint
                    and item.get("id") != tool_id
                    and timed_in_window(item, now, window)
                ):
                    continue
                stale_id = str(item.get("id") or "")
                if not stale_id or stale_id in seen_stale:
                    continue
                seen_stale.add(stale_id)
                stale_refusals.append(
                    (
                        stale_id,
                        str(item.get("fingerprint") or fingerprint),
                        str(item.get("rule") or ""),
                    )
                )
            for stale_id, stale_fp, stale_rule in stale_refusals:
                release_pending_attempt(
                    state,
                    sid,
                    stale_id,
                    release_tool_event=True,
                )
                append_block_event(
                    state,
                    sid=sid,
                    fingerprint=stale_fp,
                    now=now,
                    rule=stale_rule,
                )

            attempt = 1 + sum(
                item.get("fingerprint") == fingerprint
                and item.get("session_id") == sid
                and timed_in_window(item, now, window)
                for item in state["block_events"]
            )
            laddered = False

            failures = sum(
                item.get("fingerprint") == fingerprint
                and item.get("session_id") == sid
                and timed_in_window(item, now, window)
                for item in state["tool_failures"]
            )
            failure_max = env_int(
                "AGENT_GUARD_TOOL_FAILURE_MAX",
                DEFAULT_TOOL_FAILURE_MAX,
                1,
            )
            if failures >= failure_max and not usage_bypass:
                block_reason = (
                    "BLOCKED by agent-usage-guard's tool-error fuse: this exact tool and "
                    f"input failed {plural(failures, 'time', 'times')} in the last "
                    f"{format_duration(window)}. Do not retry it unchanged; "
                    "switch provider, change the input, or diagnose the failure."
                )

            context = effective_context(state, sid, request)
            tool_context = env_int(
                "AGENT_GUARD_TOOL_CONTEXT",
                DEFAULT_TOOL_CONTEXT,
                1,
            )
            tool_max = env_int(
                "AGENT_GUARD_TOOL_MAX",
                DEFAULT_TOOL_MAX,
                1,
            )
            recent_tools = sum(
                item.get("session_id") == sid and timed_in_window(item, now, window)
                for item in state["tool_events"]
            )
            if (
                not block_reason
                and context >= tool_context
                and recent_tools >= tool_max
                and not usage_bypass
            ):
                block_reason = (
                    "BLOCKED by agent-usage-guard's high-context turn guard: this session is "
                    f"at roughly {context:,} context tokens and already used "
                    f"{plural(recent_tools, 'tool', 'tools')} in the last "
                    f"{format_duration(window)}. "
                    "End the turn with a checkpoint; run /compact "
                    "before continuing."
                )

            if is_agent_risk and not block_reason:
                rate_limit = active_rate_limit(state, now)
                fuse_until = float(state["agent_fuses"].get(sid) or 0)
                if duplicate_pending_target:
                    block_reason = (
                        "BLOCKED by agent-usage-guard's resume guard: another "
                        f"resume for {target!r} is still awaiting confirmation. "
                        "Wait for that attempt to start, fail, or expire before "
                        "sending another resume."
                    )
                elif fuse_until > now and not (agent_bypass or usage_bypass):
                    block_reason = fuse_active_message(attempt, now, fuse_until)
                    laddered = True
                elif rate_limit and not usage_bypass:
                    block_reason = rate_limit_message(rate_limit)
                elif is_subagent_payload(payload) and not (
                    agent_bypass or usage_bypass
                ):
                    block_reason = (
                        "BLOCKED by agent-usage-guard's nested-agent guard: a subagent may "
                        "not spawn or resume another agent. Return findings to "
                        "the parent, which can schedule the next leaf agent. "
                        f"Use {AGENT_OVERRIDE_MARKER} only for intentional "
                        f"nesting, {PLACEMENT_RULE}."
                    )
                elif is_workflow and not (agent_bypass or usage_bypass):
                    block_reason = (
                        "BLOCKED by agent-usage-guard's Workflow guard: a Workflow "
                        "can launch up to 16 agents concurrently and 1,000 in one "
                        "run, while lifecycle hooks observe starts only after they "
                        "happen. Use bounded Agent calls instead, or place "
                        f"{marker_directive(AGENT_OVERRIDE_MARKER)} for a "
                        "deliberate Workflow."
                    )

                existing_entry = next(
                    (
                        item
                        for item in (
                            state["agent_pending"]
                            + state["agent_leases"]
                            + state["agent_history"]
                        )
                        if item.get("tool_use_id") == tool_id
                        and item.get("session_id") == sid
                    ),
                    None,
                )
                if existing_entry is not None:
                    return 0

                active_max = env_int(
                    "AGENT_GUARD_AGENT_MAX",
                    DEFAULT_ACTIVE_AGENT_MAX,
                    1,
                )
                rolling_max = env_int(
                    "AGENT_GUARD_ROLLING_MAX",
                    DEFAULT_AGENT_START_MAX,
                    1,
                )
                agent_context_max = env_int(
                    "AGENT_GUARD_CONTEXT_MAX",
                    DEFAULT_AGENT_CONTEXT_MAX,
                    1,
                )
                recent_agent_context = sum(
                    nonnegative_int(item.get("context"))
                    for item in state["usage_events"]
                    if item.get("subagent")
                    and float(item.get("at") or 0) >= now - window
                )
                if (
                    not block_reason
                    and agent_budget_used(
                        state,
                        now,
                        window,
                        active=True,
                    )
                    >= active_max
                    and not (agent_bypass or usage_bypass)
                ):
                    block_reason = (
                        "BLOCKED by agent-usage-guard's active-agent guard: "
                        f"{plural(active_max, 'agent is', 'agents are')} "
                        "already active or reserved. "
                        "Wait for one to finish or for an unconfirmed reservation "
                        "to clear before starting or resuming another."
                    )
                elif (
                    not block_reason
                    and agent_budget_used(
                        state,
                        now,
                        window,
                        active=False,
                    )
                    >= rolling_max
                    and not (agent_bypass or usage_bypass)
                ):
                    block_reason = (
                        "BLOCKED by agent-usage-guard's rolling agent guard: "
                        f"{plural(rolling_max, 'start/resume was', 'starts/resumes were')} "
                        "observed or reserved in "
                        f"the last {format_duration(window)}. Agent completion "
                        "does not reset this budget."
                    )
                elif (
                    not block_reason
                    and recent_agent_context >= agent_context_max
                    and not (agent_bypass or usage_bypass)
                ):
                    block_reason = (
                        "BLOCKED by agent-usage-guard's agent-context guard: subagents have "
                        f"already carried about {recent_agent_context:,} raw "
                        f"context tokens in the last {format_duration(window)}. "
                        "Wait for the window to clear."
                    )

            # A guard trip escalates to the user rather than denying outright, so
            # the outcome is unknown here and the refusal ladder cannot advance.
            # permission_denied records the block event if the user declines.
            # Two states still refuse without asking: a fuse that is already
            # burning, and the attempt that trips it.
            trip_rule = ""
            if block_reason:
                fuse_max = env_int(
                    "AGENT_GUARD_BLOCK_FUSE_MAX",
                    DEFAULT_BLOCK_FUSE_MAX,
                    2,
                )
                trip_rule = rule_from_message(block_reason)
                if laddered:
                    hard_deny = True
                else:
                    attempt = ladder_attempt(
                        state,
                        sid,
                        fingerprint,
                        trip_rule,
                        now,
                        window,
                    )
                    condition_scoped = trip_rule in CONDITION_SCOPED_RULES
                    if (
                        is_agent_risk
                        and attempt >= fuse_max
                        and not (agent_bypass or usage_bypass)
                    ):
                        until = now + env_int(
                            "AGENT_GUARD_BLOCK_FUSE_SECONDS",
                            DEFAULT_BLOCK_FUSE_SECONDS,
                            1,
                        )
                        state["agent_fuses"][sid] = until
                        block_reason = fuse_trip_message(
                            attempt,
                            now,
                            until,
                            window,
                            condition_scoped=condition_scoped,
                        )
                        trip_rule = rule_from_message(block_reason)
                        hard_deny = True
                    else:
                        block_reason = ladder_message(
                            block_reason,
                            attempt,
                            now,
                            is_agent_risk,
                            fuse_max,
                            condition_scoped=condition_scoped,
                        )
                        # A mode that suppresses prompting has no dialog to raise, so
                        # an ask would most likely be auto-approved - silently
                        # removing the guard's teeth in exactly the mode where a
                        # runaway is most likely. Refuse outright instead.
                        hard_deny = not prompts_the_user(payload)

                if hard_deny:
                    # No PermissionDenied follows a hard refusal, so the ladder
                    # has to be advanced here rather than by the user's answer.
                    append_block_event(
                        state,
                        sid=sid,
                        fingerprint=fingerprint,
                        now=now,
                        rule=trip_rule,
                    )

            # An escalated call may still run, and PostToolUse ignores any call
            # with no reservation behind it, so reserve exactly as the allowed
            # path does. permission_denied releases both writes on a refusal.
            if not hard_deny:
                if is_direct_agent_action and not any(
                    item.get("tool_use_id") == tool_id and item.get("session_id") == sid
                    for item in (
                        state["agent_pending"]
                        + state["agent_leases"]
                        + state["agent_history"]
                    )
                ):
                    stored_path, stored_offset = transcript_offset(payload)
                    agent_type = (
                        tool_input.get("subagent_type")
                        if tool_name in {"Agent", "Task"}
                        and isinstance(tool_input.get("subagent_type"), str)
                        else ""
                    )
                    agent_name = (
                        tool_input.get("name")
                        if tool_name in {"Agent", "Task"}
                        and isinstance(tool_input.get("name"), str)
                        else ""
                    )
                    entry = {
                        "at": now,
                        "expires_at": now
                        + env_int(
                            "AGENT_GUARD_PENDING_SECONDS",
                            DEFAULT_PENDING_AGENT_SECONDS,
                            1,
                        ),
                        "session_id": sid,
                        "tool_use_id": tool_id,
                        "target": (
                            target
                            if tool_name == "SendMessage"
                            else agent_name or agent_type
                        ),
                        "agent_id": (
                            known_target_agent_id if tool_name == "SendMessage" else ""
                        ),
                        "agent_type": agent_type,
                        "kind": ("resume" if tool_name == "SendMessage" else "start"),
                        "source": "pre_tool_pending",
                        "transcript_path": stored_path,
                        "offset": stored_offset,
                        # Marks a reservation whose dialog is still unanswered,
                        # so an unresolved one can be read back as a refusal.
                        "escalated": bool(block_reason),
                        "fingerprint": fingerprint,
                        "rule": trip_rule,
                    }
                    state["agent_pending"].append(entry)

                state["tool_events"].append(
                    {
                        "id": tool_id,
                        "at": now,
                        "retention_until": now + MAX_WINDOW_SECONDS,
                        "session_id": sid,
                        # Carries the escalation for calls that reserve nothing,
                        # so an unresolved one can be read back as a refusal.
                        # A direct agent action is excluded deliberately: its
                        # reservation already carries the marker and is cleared
                        # when the agent starts, so approval is observable
                        # there. A tool event has no such lifecycle, and
                        # marking one would charge a denial to an agent the
                        # user allowed.
                        "fingerprint": fingerprint,
                        "escalated": bool(block_reason) and not is_direct_agent_action,
                        "rule": trip_rule,
                    }
                )
    except OSError:
        if is_workflow:
            return block_tool(
                "BLOCKED by agent-usage-guard's Workflow guard: shared state "
                "was unavailable, and opaque multi-agent Workflows fail closed. "
                "Use bounded Agent calls after the state issue is resolved."
            )
        return 0

    if not block_reason:
        return 0
    kwargs = {
        "attempt": attempt,
        "fingerprint": fingerprint,
        "now": now,
    }
    return (
        block_tool(block_reason, **kwargs)
        if hard_deny
        else ask_tool(block_reason, **kwargs)
    )


def tool_failure(payload: dict[str, Any], now: float, window: int) -> int:
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        return 0
    sid = session_id(payload)
    supplied_tool_id = payload.get("tool_use_id")
    agent_attempt = tool_name in {"Agent", "Task"} or is_resumable_send(
        tool_name,
        tool_input,
    )
    if payload.get("is_interrupt") is True:
        if agent_attempt:
            try:
                with locked_state(now, window) as state:
                    release_agent_attempt(
                        state,
                        sid,
                        str(supplied_tool_id or ""),
                    )
            except OSError:
                pass
        return 0
    fingerprint = tool_fingerprint(tool_name, tool_input)
    failure_id = (
        supplied_tool_id
        if isinstance(supplied_tool_id, str) and supplied_tool_id
        else canonical_hash(
            [session_id(payload), fingerprint, payload.get("error"), int(now)]
        )
    )
    should_warn = False
    count = 0
    try:
        with locked_state(now, window) as state:
            if any(
                item.get("id") == failure_id and item.get("session_id") == sid
                for item in state["tool_failures"]
            ):
                return 0
            if agent_attempt:
                release_agent_attempt(
                    state,
                    sid,
                    str(supplied_tool_id or ""),
                )
            state["tool_failures"].append(
                {
                    "id": failure_id,
                    "at": now,
                    "retention_until": now + MAX_WINDOW_SECONDS,
                    "fingerprint": fingerprint,
                    "session_id": sid,
                    "tool": tool_name,
                }
            )
            count = sum(
                item.get("fingerprint") == fingerprint
                and item.get("session_id") == sid
                and timed_in_window(item, now, window)
                for item in state["tool_failures"]
            )
            failure_max = env_int(
                "AGENT_GUARD_TOOL_FAILURE_MAX",
                DEFAULT_TOOL_FAILURE_MAX,
                1,
            )
            notice_key = canonical_hash(["tool-failure", sid, fingerprint, count])
            should_warn = count >= failure_max and add_notice(
                state,
                notice_key,
                now,
                window,
            )
    except OSError:
        return 0
    if should_warn:
        return add_context(
            "PostToolUseFailure",
            "USAGE GUARD: this exact tool input has failed "
            f"{plural(count, 'time', 'times')}. "
            "Do not submit it unchanged again; diagnose the error, change the "
            "input, or switch tools/providers. A retry fuse is now active.",
        )
    return 0


def correlate_observed_start(
    state: dict[str, Any],
    pending: dict[str, Any],
    response_agent_id: str,
    now: float,
    *,
    completed: bool,
) -> bool:
    """Pair an ambiguous lifecycle observation with a tool-correlated attempt."""

    sid = str(pending.get("session_id") or "")
    agent_type = str(pending.get("agent_type") or "")
    candidates = [
        item
        for item in state["agent_history"]
        if item.get("source") == "observed_unreserved"
        and item.get("session_id") == sid
        and not item.get("origin_tool_use_id")
        and (
            (response_agent_id and agent_entry_matches(item, response_agent_id))
            or (
                not response_agent_id
                and agent_type
                and item.get("agent_type") == agent_type
            )
        )
    ]
    if not candidates:
        return False
    observed = candidates[0]
    observed["origin_tool_use_id"] = pending.get("tool_use_id")
    observed["ambiguous_pending"] = False
    observed["ambiguous_tool_ids"] = []
    observed_id = observed.get("tool_use_id")
    for lease in state["agent_leases"]:
        if lease.get("tool_use_id") == observed_id:
            lease["origin_tool_use_id"] = pending.get("tool_use_id")
            lease["ambiguous_pending"] = False
            lease["ambiguous_tool_ids"] = []
    alias = pending.get("target")
    remember_agent(state, sid, alias, now)
    if response_agent_id:
        bind_agent_alias(state, sid, alias, response_agent_id, now)
    if completed and response_agent_id:
        state["agent_leases"] = [
            item
            for item in state["agent_leases"]
            if item.get("tool_use_id") != observed_id
        ]
    return True


def post_tool(payload: dict[str, Any], now: float, window: int) -> int:
    """Confirm or terminalize a provisional agent attempt after tool success."""

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    tool_id = payload.get("tool_use_id")
    if (
        tool_name not in {"Agent", "Task", "SendMessage"}
        or not isinstance(tool_input, dict)
        or not isinstance(tool_id, str)
        or not tool_id
    ):
        return 0
    sid = session_id(payload)
    response = payload.get("tool_response")
    response_dict = response if isinstance(response, dict) else {}
    response_text = json.dumps(response, default=str).lower()
    response_failed = (
        response_dict.get("success") is False
        or response_dict.get("is_error") is True
        or any(
            phrase in response_text
            for phrase in (
                '"status": "failed"',
                '"status":"failed"',
                "agent not found",
                "no such agent",
            )
        )
    )
    try:
        with locked_state(now, window) as state:
            matching_index = next(
                (
                    index
                    for index, item in enumerate(state["agent_pending"])
                    if item.get("tool_use_id") == tool_id
                    and item.get("session_id") == sid
                ),
                None,
            )
            if matching_index is None:
                return 0
            if response_failed:
                release_pending_attempt(
                    state,
                    sid,
                    tool_id,
                    release_tool_event=True,
                )
                return 0

            pending = state["agent_pending"][matching_index]
            explicit_response_agent_id = (
                response_dict.get("agentId")
                or response_dict.get("agent_id")
                or response_dict.get("resumedAgentId")
                or response_dict.get("resumed_agent_id")
                or response_dict.get("taskId")
                or response_dict.get("task_id")
                or response_dict.get("teammateId")
                or response_dict.get("teammate_id")
            )
            explicit_response_agent_id = (
                explicit_response_agent_id
                if isinstance(explicit_response_agent_id, str)
                else ""
            )
            if not explicit_response_agent_id and isinstance(response, str):
                string_agent_id = re.search(
                    r"\bagent\s*id\s*[:=]\s*([a-z0-9_-]+)",
                    response,
                    re.IGNORECASE,
                )
                if string_agent_id:
                    explicit_response_agent_id = string_agent_id.group(1)
            response_agent_id = explicit_response_agent_id or pending.get("agent_id")
            response_agent_id = (
                response_agent_id if isinstance(response_agent_id, str) else ""
            )
            status = str(response_dict.get("status") or "").lower()
            response_completed = (
                status in {"completed", "complete"}
                or "ran to completion" in response_text
            )
            if tool_name in {"Agent", "Task"} and correlate_observed_start(
                state,
                pending,
                explicit_response_agent_id,
                now,
                completed=response_completed,
            ):
                state["agent_pending"].pop(matching_index)
                return 0
            if tool_name in {"Agent", "Task"} and response_completed:
                terminalize_agent_attempt(
                    state,
                    sid,
                    tool_id,
                    now,
                    window,
                    "confirmed_tool_completion",
                )
                return 0
            if tool_name in {"Agent", "Task"} and not explicit_response_agent_id:
                # Without a stable ID, keep the short-lived pending reservation
                # for SubagentStart to bind rather than inventing a six-hour
                # anonymous lease.
                return 0
            if tool_name == "SendMessage" and response_completed:
                terminalize_agent_attempt(
                    state,
                    sid,
                    tool_id,
                    now,
                    window,
                    "confirmed_tool_completion",
                )
                return 0

            pending = state["agent_pending"].pop(matching_index)
            lease = {
                key: value
                for key, value in pending.items()
                if key not in {"expires_at", "offset", "transcript_path"}
            }
            lease["at"] = now
            lease["expires_at"] = now + env_int(
                "AGENT_GUARD_LEASE_SECONDS",
                DEFAULT_ACTIVE_LEASE_SECONDS,
                1,
            )
            lease["retention_until"] = now + MAX_WINDOW_SECONDS
            lease["source"] = "confirmed_tool_success"
            if response_agent_id:
                lease["agent_id"] = response_agent_id
            state["agent_leases"].append(dict(lease))
            if not any(
                item.get("tool_use_id") == tool_id and item.get("session_id") == sid
                for item in state["agent_history"]
            ):
                state["agent_history"].append(dict(lease))
            bind_agent_alias(
                state,
                sid,
                lease.get("target"),
                response_agent_id,
                now,
            )
    except OSError:
        pass
    return 0


def observe_stop(payload: dict[str, Any], now: float, window: int) -> int:
    request = latest_request(payload)
    try:
        with locked_state(now, window) as state:
            record_usage(state, request, now, window)
    except OSError:
        pass
    return 0


def stop_failure(payload: dict[str, Any], now: float, window: int) -> int:
    error = payload.get("error_type") or payload.get("error")
    if error not in {"rate_limit", "billing_error"}:
        return 0
    error_message = payload.get("error_message")
    error_message = error_message if isinstance(error_message, str) else ""
    text = " ".join(
        str(payload.get(key) or "")
        for key in (
            "error_message",
            "last_assistant_message",
            "error_details",
        )
    )
    lower = text.lower()
    # Exhausting one model is not an account-wide stop: Claude explicitly
    # allows continuing on another model. Do not turn it into a global circuit.
    #
    # The remedy Claude Code prints is the reliable signal, because it names a
    # model switch only when another model still works. Reading the model name
    # instead would not help: the guard runs before the next request, so the
    # transcript still ends on the exhausted model and a switched session would
    # stay blocked - which is how running out of credits for one model blocked
    # every model, with the denial itself pointing at the /model that could not
    # clear it. The remedy is checked for both error types, since credit
    # exhaustion arrives as a billing failure while a plan limit arrives as a
    # rate limit, and neither is account-wide when a switch is on offer.
    scoped_limit_text = (
        error_message or str(payload.get("last_assistant_message") or "")
    ).lower()
    opus_scoped = re.search(
        r"(?:\bopus\b[^.\n]{0,24}\blimit\b|"
        r"\blimit\b[^.\n]{0,24}\bopus\b)",
        scoped_limit_text,
    )
    if MODEL_SWITCH_REMEDY_PATTERN.search(scoped_limit_text) or (
        error == "rate_limit" and opus_scoped
    ):
        return 0
    parsed_until = parse_reset_until(text, now)
    if error == "billing_error":
        category = "spend"
        fallback = env_int(
            "AGENT_GUARD_SESSION_COOLDOWN_SECONDS",
            DEFAULT_SESSION_LIMIT_COOLDOWN,
            1,
        )
    elif any(
        phrase in lower for phrase in ("session limit", "5-hour limit", "weekly limit")
    ):
        category = "session"
        fallback = env_int(
            "AGENT_GUARD_SESSION_COOLDOWN_SECONDS",
            DEFAULT_SESSION_LIMIT_COOLDOWN,
            1,
        )
    elif "monthly spend limit" in lower or "usage credits" in lower:
        category = "spend"
        fallback = env_int(
            "AGENT_GUARD_SESSION_COOLDOWN_SECONDS",
            DEFAULT_SESSION_LIMIT_COOLDOWN,
            1,
        )
    else:
        category = "rate"
        fallback = env_int(
            "AGENT_GUARD_RATE_COOLDOWN_SECONDS",
            DEFAULT_RATE_LIMIT_COOLDOWN,
            1,
        )
    until = parsed_until or now + fallback
    try:
        with locked_state(now, window) as state:
            existing = active_rate_limit(state, now)
            if existing and float(existing["until"]) > until:
                return 0
            state["rate_limit"] = {
                "at": now,
                "until": until,
                "category": category,
            }
            record_intervention(
                decision="circuit_arm",
                rule="usage circuit breaker",
                now=now,
            )
    except OSError:
        pass
    return 0


def subagent_start(payload: dict[str, Any], now: float, window: int) -> int:
    agent_id = payload.get("agent_id")
    agent_id = agent_id if isinstance(agent_id, str) else ""
    if not agent_id:
        return 0
    agent_type = payload.get("agent_type")
    agent_type = agent_type if isinstance(agent_type, str) else ""
    sid = session_id(payload)
    ambiguous_pending = False
    ambiguous_tool_ids: list[str] = []
    try:
        with locked_state(now, window) as state:
            active = next(
                (
                    item
                    for item in state["agent_leases"]
                    if agent_entry_matches(item, agent_id)
                    and (not sid or item.get("session_id") == sid)
                ),
                None,
            )
            if active is not None:
                remember_agent(state, sid, agent_id, now)
                bind_agent_alias(state, sid, agent_type, agent_id, now)
                return 0

            matching_index = next(
                (
                    index
                    for index, item in enumerate(state["agent_pending"])
                    if agent_entry_matches(item, agent_id)
                    and (not sid or item.get("session_id") == sid)
                ),
                None,
            )
            if (
                matching_index is None
                and agent_type
                and agent_type not in UNRESERVED_AGENT_TYPES
            ):
                typed_candidates = [
                    index
                    for index, item in enumerate(state["agent_pending"])
                    if (not sid or item.get("session_id") == sid)
                    and (
                        item.get("agent_type") == agent_type
                        or item.get("target") == agent_type
                    )
                ]
                candidate_targets = {
                    str(state["agent_pending"][index].get("target") or "")
                    for index in typed_candidates
                }
                if len(typed_candidates) == 1 or len(candidate_targets) == 1:
                    matching_index = typed_candidates[0]
                elif typed_candidates:
                    ambiguous_pending = True
                    ambiguous_tool_ids = [
                        str(state["agent_pending"][index].get("tool_use_id") or "")
                        for index in typed_candidates
                        if state["agent_pending"][index].get("tool_use_id")
                    ]
            if matching_index is None and agent_type not in UNRESERVED_AGENT_TYPES:
                broad_candidates = [
                    index
                    for index, item in enumerate(state["agent_pending"])
                    if (
                        (item.get("kind") == "start" and not item.get("target"))
                        or (item.get("kind") == "resume" and not item.get("agent_id"))
                    )
                    and (not sid or item.get("session_id") == sid)
                ]
                if broad_candidates:
                    matching_index = broad_candidates[0]
            alias = ""
            if matching_index is not None:
                matching = state["agent_pending"].pop(matching_index)
                alias = (
                    matching.get("target")
                    if isinstance(matching.get("target"), str)
                    else ""
                )
                lease = {
                    key: value
                    for key, value in matching.items()
                    if key not in {"expires_at", "offset", "transcript_path"}
                }
                lease["at"] = now
                lease["expires_at"] = now + env_int(
                    "AGENT_GUARD_LEASE_SECONDS",
                    DEFAULT_ACTIVE_LEASE_SECONDS,
                    1,
                )
                lease["retention_until"] = now + MAX_WINDOW_SECONDS
                lease["agent_id"] = agent_id
                lease["source"] = "confirmed_start"
                if not alias:
                    lease["target"] = agent_id
                state["agent_leases"].append(dict(lease))
                if not any(
                    item.get("tool_use_id") == lease.get("tool_use_id")
                    and item.get("session_id") == lease.get("session_id")
                    for item in state["agent_history"]
                ):
                    state["agent_history"].append(dict(lease))
            else:
                entry = {
                    "at": now,
                    "expires_at": now
                    + env_int(
                        "AGENT_GUARD_LEASE_SECONDS",
                        DEFAULT_ACTIVE_LEASE_SECONDS,
                        1,
                    ),
                    "retention_until": now + MAX_WINDOW_SECONDS,
                    "session_id": sid,
                    "tool_use_id": (
                        f"observed:{canonical_hash([sid, agent_id, agent_type, now])}"
                    ),
                    "target": agent_id,
                    "agent_id": agent_id,
                    "agent_type": agent_type,
                    "kind": "start",
                    "source": "observed_unreserved",
                    "ambiguous_pending": ambiguous_pending,
                    "ambiguous_tool_ids": ambiguous_tool_ids,
                }
                state["agent_leases"].append(dict(entry))
                state["agent_history"].append(dict(entry))
            remember_agent(state, sid, agent_id, now)
            bind_agent_alias(state, sid, alias, agent_id, now)
            bind_agent_alias(state, sid, agent_type, agent_id, now)
    except OSError:
        pass
    return 0


def subagent_stop(payload: dict[str, Any], now: float, window: int) -> int:
    requests = transcript_requests(payload)
    agent_id = payload.get("agent_id")
    agent_id = agent_id if isinstance(agent_id, str) else ""
    sid = session_id(payload)
    try:
        with locked_state(now, window) as state:
            for request in requests:
                record_usage(state, request, now, window)
            if not agent_id:
                return 0
            stopped_type = payload.get("agent_type")
            stopped_type = stopped_type if isinstance(stopped_type, str) else ""
            exact_matches = [
                item
                for item in state["agent_leases"]
                if agent_entry_matches(item, agent_id)
                and (not sid or item.get("session_id") == sid)
            ]
            if exact_matches:
                matched_ids = {id(item) for item in exact_matches}
                state["agent_leases"] = [
                    item
                    for item in state["agent_leases"]
                    if id(item) not in matched_ids
                ]
            elif stopped_type:
                unbound_matches = [
                    item
                    for item in state["agent_leases"]
                    if not item.get("agent_id")
                    and agent_entry_matches(item, stopped_type)
                    and (not sid or item.get("session_id") == sid)
                ]
                if len(unbound_matches) == 1:
                    unbound_id = id(unbound_matches[0])
                    state["agent_leases"] = [
                        item for item in state["agent_leases"] if id(item) != unbound_id
                    ]
            remember_agent(state, sid, agent_id, now)
            bind_agent_alias(
                state,
                sid,
                payload.get("agent_type"),
                agent_id,
                now,
            )
    except OSError:
        pass
    return 0


def permission_denied(payload: dict[str, Any], now: float, window: int) -> int:
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    supplied_tool_id = payload.get("tool_use_id")
    if (
        not isinstance(tool_name, str)
        or not isinstance(supplied_tool_id, str)
        or not supplied_tool_id
    ):
        return 0
    is_agent_action = isinstance(tool_input, dict) and (
        tool_name in {"Agent", "Task"}
        or is_resumable_send(
            tool_name,
            tool_input,
        )
    )
    try:
        with locked_state(now, window) as state:
            sid = session_id(payload)
            rule = ""
            if is_agent_action:
                pending = next(
                    (
                        item
                        for item in state.get("agent_pending", [])
                        if item.get("tool_use_id") == supplied_tool_id
                        and item.get("session_id") == sid
                    ),
                    None,
                )
                if pending:
                    rule = str(pending.get("rule") or "")
                release_pending_attempt(
                    state,
                    sid,
                    supplied_tool_id,
                    release_tool_event=True,
                )
            else:
                matching = next(
                    (
                        item
                        for item in state.get("tool_events", [])
                        if item.get("id") == supplied_tool_id
                        and item.get("session_id") == sid
                    ),
                    None,
                )
                if matching:
                    rule = str(matching.get("rule") or "")
                state["tool_events"] = [
                    item
                    for item in state["tool_events"]
                    if not (
                        item.get("id") == supplied_tool_id
                        and item.get("session_id") == sid
                    )
                ]
            # An escalated guard trip cannot know at PreToolUse time whether the
            # user will allow it, so the refusal ladder is advanced here instead.
            # Only a real refusal counts; an approved call costs nothing.
            if isinstance(tool_input, dict):
                append_block_event(
                    state,
                    sid=sid,
                    fingerprint=tool_fingerprint(tool_name, tool_input),
                    now=now,
                    rule=rule,
                )
    except OSError:
        pass
    return 0


def post_compact(payload: dict[str, Any], now: float, window: int) -> int:
    sid = session_id(payload)
    if not sid:
        return 0
    try:
        with locked_state(now, window) as state:
            state["compactions"][sid] = now
            state["tool_events"] = [
                item for item in state["tool_events"] if item.get("session_id") != sid
            ]
            state["dormant_resumes"] = [
                item
                for item in state["dormant_resumes"]
                if item.get("session_id") != sid
            ]
    except OSError:
        pass
    return 0


def format_report(events: list[dict[str, Any]], *, days: int) -> str:
    if not events:
        return (
            f"agent-usage-guard: no interventions recorded in the last {days} "
            "day(s) on this machine."
        )

    by_decision: dict[str, int] = {}
    by_rule: dict[str, int] = {}
    by_tool: dict[str, int] = {}
    by_bucket: dict[str, int] = {}
    for item in events:
        decision = str(item.get("decision") or "unknown")
        rule = str(item.get("rule") or "unknown")
        by_decision[decision] = by_decision.get(decision, 0) + 1
        by_rule[rule] = by_rule.get(rule, 0) + 1
        tool_name = item.get("tool_name")
        if isinstance(tool_name, str) and tool_name:
            by_tool[tool_name] = by_tool.get(tool_name, 0) + 1
        bucket = item.get("context_bucket")
        if isinstance(bucket, str) and bucket:
            by_bucket[bucket] = by_bucket.get(bucket, 0) + 1

    stops = sum(by_decision.get(key, 0) for key in ("deny", "ask", "fuse_trip"))
    lines = [
        (
            f"agent-usage-guard: {len(events)} intervention(s) in the last "
            f"{days} day(s) on this machine."
        ),
        (
            f"Stopped or escalated {stops} call(s) "
            f"({by_decision.get('ask', 0)} ask, "
            f"{by_decision.get('deny', 0)} deny, "
            f"{by_decision.get('fuse_trip', 0)} fuse trip)."
        ),
    ]
    if by_decision.get("notice"):
        lines.append(f"Notices: {by_decision['notice']}.")
    if by_decision.get("override_arm"):
        lines.append(f"Overrides armed: {by_decision['override_arm']}.")
    if by_decision.get("circuit_arm"):
        lines.append(f"Circuit breaker armed: {by_decision['circuit_arm']}.")
    lines.append("By rule:")
    for rule, count in sorted(by_rule.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"  {count:>4}  {rule}")
    if by_tool:
        lines.append(
            "By tool: "
            + ", ".join(f"{name} {by_tool[name]}" for name in sorted(by_tool))
        )
    if by_bucket:
        lines.append(
            "By context: "
            + ", ".join(
                f"{label} {by_bucket[label]}"
                for label in CONTEXT_BUCKET_ORDER
                if label in by_bucket
            )
        )
    return "\n".join(lines)


def report_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="agent-usage-guard.py report",
        description=(
            "Summarise local guard interventions on this machine. "
            "Reads the privacy-minimal events journal only."
        ),
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="How many days of journal history to include (default: 30)",
    )
    args = parser.parse_args(argv)
    days = max(1, int(args.days))
    now = now_seconds()
    since = now - days * 24 * 60 * 60
    events = load_events(now=now, since=since)
    print(format_report(events, days=days))
    return 0


def dispatch(
    mode: str,
    payload: dict[str, Any],
    now: float,
    window: int,
) -> int:
    token = bind_hook_context(mode, payload)
    try:
        if mode == "prompt":
            return prompt_guard(payload, now, window)
        if mode == "prompt-expansion":
            return prompt_expansion_guard(payload, now, window)
        if mode == "pre-tool":
            return pre_tool_guard(payload, now, window)
        if mode == "post-tool":
            return post_tool(payload, now, window)
        if mode == "tool-failure":
            return tool_failure(payload, now, window)
        if mode == "observe-stop":
            return observe_stop(payload, now, window)
        if mode == "stop-failure":
            return stop_failure(payload, now, window)
        if mode == "subagent-start":
            return subagent_start(payload, now, window)
        if mode == "subagent-stop":
            return subagent_stop(payload, now, window)
        if mode == "permission-denied":
            return permission_denied(payload, now, window)
        if mode == "post-compact":
            return post_compact(payload, now, window)
        return 0
    finally:
        _hook_context.reset(token)


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "report":
        try:
            return report_main(argv[2:])
        except Exception:  # noqa: BLE001 - report must not crash the shell.
            return 0
    if not enabled() or foreign_host():
        return 0
    try:
        mode = argv[1] if len(argv) > 1 else ""
        payload = read_payload()
        if payload is None:
            return 0
        now = now_seconds()
        window = min(
            MAX_WINDOW_SECONDS,
            env_int(
                "AGENT_GUARD_WINDOW_SECONDS",
                DEFAULT_WINDOW_SECONDS,
                1,
            ),
        )
        return dispatch(mode, payload, now, window)
    except Exception:  # noqa: BLE001 - this is the hook's final crash-safe boundary.
        # Hook input, transcripts, environment variables, and persisted state
        # are all outside this process's trust boundary. The guard's final
        # invariant is to fail open rather than wedge Claude Code.
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
