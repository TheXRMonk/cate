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
_HOOKS = (
    "on_session_start",
    "on_session_reset",
    "pre_llm_call",
    "on_session_end",
    "on_session_finalize",
)


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


def _report(hook_event_name: str, profile: str, **kwargs: Any) -> None:
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
            **{key: kwargs[key] for key in ("turn_id", "waiting_reason", "failed", "interrupted")
               if key in kwargs},
        },
    }
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
        _report(name, profile, **kwargs)

    return report


def register(ctx: Any) -> None:
    profile = str(getattr(ctx, "profile_name", "custom"))
    lock = threading.RLock()
    session = None
    turn = None
    pending: set[tuple[str, str]] = set()

    def lifecycle(name: str, **kwargs: Any) -> None:
        nonlocal session, turn
        with lock:
            if name == "on_session_end" and session and kwargs.get("session_id") == session:
                if kwargs.get("turn_id") and kwargs.get("turn_id") != turn:
                    return
            if name == "pre_llm_call" and kwargs.get("platform") in _INTERACTIVE_PLATFORMS:
                if (session, turn) != (kwargs.get("session_id"), kwargs.get("turn_id")):
                    pending.clear()
                session, turn = kwargs.get("session_id"), kwargs.get("turn_id")
            if name in {"on_session_start", "on_session_reset", "on_session_end", "on_session_finalize"}:
                if kwargs.get("session_id") == session:
                    if not kwargs.get("turn_id") or kwargs.get("turn_id") == turn:
                        pending.clear()
                        turn = None
            _report(name, profile, **kwargs)

    def wait_event(name: str, **kwargs: Any) -> None:
        with lock:
            if (not session or not turn or kwargs.get("session_id") != session
                    or kwargs.get("turn_id") != turn):
                return
            if name in {"pre_approval_request", "post_approval_response"} and kwargs.get("surface") != "cli":
                return
            tool = kwargs.get("tool_call_id")
            if not isinstance(tool, str) or not tool:
                return
            before = set(pending)
            if name == "pre_approval_request":
                pending.add((tool, "approval"))
            elif name == "pre_tool_call":
                if kwargs.get("tool_name") == "clarify":
                    # Tool execution brackets the wait, not proof of prompt visibility.
                    pending.add((tool, "question"))
            elif name == "post_approval_response":
                pending.discard((tool, "approval"))
            else:
                pending.difference_update({item for item in pending if item[0] == tool})
            if before == pending:
                return
            if pending:
                reason = "approval" if any(kind == "approval" for _, kind in pending) else "question"
                _report("cate_wait_started", profile, session_id=session, turn_id=turn,
                        platform="cli", waiting_reason=reason)
            else:
                _report("cate_wait_resolved", profile, session_id=session, turn_id=turn,
                        platform="cli")

    for name in _HOOKS:
        ctx.register_hook(name, lambda _name=name, **kw: lifecycle(_name, **kw))
    for name in ("pre_approval_request", "post_approval_response", "pre_tool_call", "post_tool_call"):
        ctx.register_hook(name, lambda _name=name, **kw: wait_event(_name, **kw))
