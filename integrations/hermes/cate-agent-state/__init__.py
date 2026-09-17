"""Hermes lifecycle bridge for Cate terminal session restoration."""

from __future__ import annotations

import json
import os
import re
import time
import threading
from typing import Any, Callable
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

PLUGIN_ID = "cate-agent-state"
PLUGIN_VERSION = "1.2.0"
_PROCESS_STARTED_AT = str(time.monotonic_ns())
_INTERACTIVE_PLATFORMS = frozenset({"cli", "tui"})
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SUBAGENT_ID_RE = re.compile(r"^sa-[A-Za-z0-9_-]{1,124}$")
_HOOKS = (
    "on_session_start",
    "on_session_reset",
    "pre_llm_call",
    "on_session_end",
    "on_session_finalize",
)
_SUBAGENT_HOOKS = ("subagent_start", "subagent_stop")
_MAX_SUBAGENT_GOAL_CHARS = 4_000
_MAX_SUBAGENT_SUMMARY_CHARS = 12_000
_MAX_SUBAGENTS_PER_ROOT = 64
_ROOT_SESSION_ID: str | None = None
_SUBAGENT_SEQUENCE = 0
_SUBAGENTS: dict[str, dict[str, Any]] = {}
_SUBAGENT_LOCK = threading.Lock()


class _RejectRedirects(HTTPRedirectHandler):
    """Never forward Cate's terminal bearer token to a redirected endpoint."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Ignore ambient HTTP(S)_PROXY settings: this transport is loopback-only.
_OPENER = build_opener(ProxyHandler({}), _RejectRedirects())


def _cate_connection() -> tuple[str, str, str] | None:
    endpoint = os.environ.get("CATE_HOOK_ENDPOINT", "")
    token = os.environ.get("CATE_HOOK_TOKEN", "")
    terminal_id = os.environ.get("CATE_TERMINAL_ID", "")
    if not endpoint or not token or not terminal_id:
        return None
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return None
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}:
        return None
    return endpoint, token, terminal_id


def _report(
    hook_event_name: str,
    profile: str,
    *,
    extra_payload: dict[str, Any] | None = None,
    **kwargs: Any,
) -> None:
    connection = _cate_connection()
    if connection is None:
        return
    if profile == "custom" or not _PROFILE_RE.fullmatch(profile):
        return
    platform = str(kwargs.get("platform") or "")
    if platform and platform not in _INTERACTIVE_PLATFORMS:
        return
    endpoint, token, terminal_id = connection
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = ""
    body = {
        "agentId": "hermes",
        "terminalId": terminal_id,
        "pid": os.getpid(),
        "processStartedAt": _PROCESS_STARTED_AT,
        "payload": {
            "hook_event_name": hook_event_name,
            "session_id": kwargs.get("session_id"),
            "cwd": cwd,
            "profile": profile,
            "platform": platform,
            "reason": kwargs.get("reason"),
        },
    }
    if extra_payload:
        body["payload"].update({key: value for key, value in extra_payload.items() if value is not None})
    try:
        request = Request(
            endpoint,
            data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with _OPENER.open(request, timeout=0.75) as response:
            response.read(1)
    except Exception:
        # Hooks must never delay or break the user's Hermes session.
        return


def _callback(name: str, profile: str) -> Callable[..., None]:
    def report(**kwargs: Any) -> None:
        global _ROOT_SESSION_ID
        platform = str(kwargs.get("platform") or "")
        if platform and platform not in _INTERACTIVE_PLATFORMS:
            return
        session_id = _bounded_string(kwargs.get("session_id"), 128)
        if name in {"on_session_start", "on_session_reset", "pre_llm_call"} and session_id:
            with _SUBAGENT_LOCK:
                if _ROOT_SESSION_ID != session_id:
                    _ROOT_SESSION_ID = session_id
                    _SUBAGENTS.clear()

        elif name == "on_session_finalize":
            with _SUBAGENT_LOCK:
                if session_id and session_id == _ROOT_SESSION_ID:
                    _SUBAGENTS.clear()
                    _ROOT_SESSION_ID = None

        _report(name, profile, **kwargs)

    return report


def _bounded_string(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    return value[:limit]


def _reserve_subagent_event(name: str, kwargs: dict[str, Any]) -> dict[str, Any] | None:
    """Validate, order, and snapshot one child event while holding the lock."""
    global _SUBAGENT_SEQUENCE
    child_subagent_id = _bounded_string(kwargs.get("child_subagent_id"), 128)
    parent_session_id = _bounded_string(kwargs.get("parent_session_id"), 128)
    child_session_id = _bounded_string(kwargs.get("child_session_id"), 128)
    if name == "subagent_stop" and not child_subagent_id and child_session_id:
        matches = [
            subagent_id
            for subagent_id, child in _SUBAGENTS.items()
            if child["child_session_id"] == child_session_id
        ]
        child_subagent_id = matches[0] if len(matches) == 1 else None
    if not child_subagent_id or not _SUBAGENT_ID_RE.fullmatch(child_subagent_id):
        return None
    parent_subagent_id = _bounded_string(kwargs.get("parent_subagent_id"), 128)
    known = _SUBAGENTS.get(child_subagent_id)
    root_session_id = _ROOT_SESSION_ID
    parent_is_root = bool(root_session_id and parent_session_id == root_session_id)
    parent_record = _SUBAGENTS.get(parent_subagent_id or "")
    parent_is_known_child = bool(
        parent_subagent_id
        and parent_record
        and parent_record["root_session_id"] == root_session_id
        and parent_record["child_session_id"] == parent_session_id
    )
    if name == "subagent_start":
        if not parent_is_root and not parent_is_known_child:
            return None
        if known and known.get("terminal"):
            return None
        if known is None and len(_SUBAGENTS) >= _MAX_SUBAGENTS_PER_ROOT:
            return None
        known = {
            "root_session_id": root_session_id,
            "parent_session_id": parent_session_id or "",
            "child_session_id": child_session_id or "",
            "parent_subagent_id": parent_subagent_id,
            "child_model": _bounded_string(kwargs.get("child_model"), 128),
            "child_goal": _bounded_string(kwargs.get("child_goal"), _MAX_SUBAGENT_GOAL_CHARS),
            "terminal": False,
        }
        _SUBAGENTS[child_subagent_id] = known
    elif known is None:
        return None
    if known["root_session_id"] != root_session_id or known.get("terminal"):
        return None
    _SUBAGENT_SEQUENCE += 1
    known["sequence"] = _SUBAGENT_SEQUENCE
    if name == "subagent_stop":
        known["terminal"] = True
    return {"child_subagent_id": child_subagent_id, **known}


def _subagent_callback(name: str, profile: str) -> Callable[..., None]:
    def report(**kwargs: Any) -> None:
        with _SUBAGENT_LOCK:
            metadata = _reserve_subagent_event(name, kwargs)
        if metadata is None:
            return
        payload = {
            "root_session_id": metadata["root_session_id"],
            "parent_session_id": metadata["parent_session_id"],
            "parent_turn_id": _bounded_string(kwargs.get("parent_turn_id"), 128),
            "parent_subagent_id": metadata.get("parent_subagent_id"),
            "child_session_id": metadata["child_session_id"],
            "child_subagent_id": metadata["child_subagent_id"],
            "child_role": _bounded_string(kwargs.get("child_role"), 32),
            "child_model": _bounded_string(kwargs.get("child_model"), 128) or metadata.get("child_model"),
            "child_goal": _bounded_string(kwargs.get("child_goal"), _MAX_SUBAGENT_GOAL_CHARS) or metadata.get("child_goal"),
            "child_status": _bounded_string(kwargs.get("child_status"), 32),
            "child_summary": _bounded_string(kwargs.get("child_summary"), _MAX_SUBAGENT_SUMMARY_CHARS),
            "duration_ms": kwargs.get("duration_ms") if isinstance(kwargs.get("duration_ms"), int) else None,
            "child_sequence": metadata["sequence"],
        }
        _report(name, profile, platform="cli", extra_payload=payload)

    return report


def _reserve_subagent_progress(kwargs: dict[str, Any]) -> dict[str, Any] | None:
    global _SUBAGENT_SEQUENCE
    task_id = _bounded_string(kwargs.get("task_id"), 128)
    session_id = _bounded_string(kwargs.get("session_id"), 128)
    tool_name = _bounded_string(kwargs.get("tool_name"), 80)
    subagent_id = task_id if task_id in _SUBAGENTS else None
    if subagent_id is None and session_id:
        matches = [
            candidate
            for candidate, child in _SUBAGENTS.items()
            if child["child_session_id"] == session_id
        ]
        subagent_id = matches[0] if len(matches) == 1 else None
    child = _SUBAGENTS.get(subagent_id or "")
    if not subagent_id or not child or child.get("terminal") or not tool_name:
        return None
    _SUBAGENT_SEQUENCE += 1
    child["sequence"] = _SUBAGENT_SEQUENCE
    return {"subagent_id": subagent_id, "tool_name": tool_name, **child}


def _report_reserved_progress(profile: str, reserved: dict[str, Any] | None) -> bool:
    if not reserved:
        return False
    with _SUBAGENT_LOCK:
        current = _SUBAGENTS.get(reserved["subagent_id"])
        if not current or current.get("terminal") or current.get("sequence") != reserved["sequence"]:
            return False
    _report(
        "subagent_progress",
        profile,
        platform="cli",
        extra_payload={
            "root_session_id": reserved["root_session_id"],
            "parent_session_id": reserved["parent_session_id"],
            "parent_subagent_id": reserved.get("parent_subagent_id"),
            "child_session_id": reserved["child_session_id"],
            "child_subagent_id": reserved["subagent_id"],
            "child_goal": reserved.get("child_goal"),
            "child_sequence": reserved["sequence"],
            "latest_activity": f"Using {reserved['tool_name']}",
        },
    )
    return True


def _subagent_progress_callback(profile: str) -> Callable[..., None]:
    def report(**kwargs: Any) -> None:
        with _SUBAGENT_LOCK:
            reserved = _reserve_subagent_progress(kwargs)
        _report_reserved_progress(profile, reserved)

    return report


def register(ctx: Any) -> None:
    profile = str(getattr(ctx, "profile_name", "custom"))
    for hook_name in _HOOKS:
        ctx.register_hook(hook_name, _callback(hook_name, profile))
    for hook_name in _SUBAGENT_HOOKS:
        ctx.register_hook(hook_name, _subagent_callback(hook_name, profile))
    ctx.register_hook("pre_tool_call", _subagent_progress_callback(profile))
