from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
from urllib.request import ProxyHandler


PLUGIN_PATH = (
    Path(__file__).resolve().parents[1]
    / "integrations"
    / "hermes"
    / "cate-agent-state"
    / "__init__.py"
)
MANIFEST_PATH = PLUGIN_PATH.with_name("plugin.yaml")


def load_plugin():
    spec = importlib.util.spec_from_file_location("cate_agent_state_test", PLUGIN_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {PLUGIN_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeContext:
    def __init__(self, profile_name: str = "work") -> None:
        self.hooks: dict[str, object] = {}
        self.profile_name = profile_name

    def register_hook(self, name: str, callback) -> None:
        self.hooks[name] = callback


class CateAgentStatePluginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_session_id = os.environ.pop("HERMES_SESSION_ID", None)
        plugin = load_plugin()
        with plugin._SUBAGENT_LOCK:
            plugin._SUBAGENTS.clear()
            plugin._ROOT_SESSION_ID = None
            plugin._SUBAGENT_SEQUENCE = 0

    def activate_root(self, ctx: FakeContext, session_id: str) -> None:
        ctx.hooks["on_session_start"](session_id=session_id, platform="cli", model="gpt-test")
        os.environ["HERMES_SESSION_ID"] = session_id

    def tearDown(self) -> None:
        os.environ.pop("HERMES_SESSION_ID", None)
        if self.original_session_id is not None:
            os.environ["HERMES_SESSION_ID"] = self.original_session_id

    def test_manifest_declares_provided_hooks(self) -> None:
        manifest = MANIFEST_PATH.read_text(encoding="utf-8")
        self.assertIn("provides_hooks:", manifest)
        self.assertIn("pre_tool_call", manifest)
        self.assertIn('version: 1.2.0', manifest)
        self.assertEqual(load_plugin().PLUGIN_VERSION, "1.2.0")
        self.assertNotIn("\nhooks:", manifest)

    def test_accepts_only_literal_loopback_hook_endpoints(self) -> None:
        plugin = load_plugin()
        base_env = {
            "CATE_HOOK_TOKEN": "secret-token",
            "CATE_TERMINAL_ID": "term-1",
        }

        with patch.dict(
            os.environ,
            {**base_env, "CATE_HOOK_ENDPOINT": "http://localhost:43210"},
            clear=False,
        ):
            self.assertIsNone(plugin._cate_connection())

        with patch.dict(
            os.environ,
            {**base_env, "CATE_HOOK_ENDPOINT": "http://[::1]:43210"},
            clear=False,
        ):
            self.assertIsNotNone(plugin._cate_connection())

    def test_transport_disables_proxies_and_redirects(self) -> None:
        plugin = load_plugin()
        proxy_handlers = [
            handler for handler in plugin._OPENER.handlers
            if isinstance(handler, ProxyHandler)
        ]
        self.assertEqual(proxy_handlers, [])
        redirect_handlers = [
            handler for handler in plugin._OPENER.handlers
            if isinstance(handler, plugin._RejectRedirects)
        ]
        self.assertEqual(len(redirect_handlers), 1)
        self.assertIsNone(
            redirect_handlers[0].redirect_request(
                None, None, 302, "Found", {}, "http://example.com/leak"
            )
        )

    def test_registers_root_and_subagent_lifecycle_hooks(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()

        plugin.register(ctx)

        self.assertEqual(
            set(ctx.hooks),
            {
                "on_session_start",
                "on_session_reset",
                "pre_llm_call",
                "on_session_end",
                "on_session_finalize",
                "subagent_start",
                "subagent_stop",
                "pre_tool_call",
            },
        )

    def test_posts_bounded_subagent_lifecycle_payloads(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
                "HERMES_SESSION_ID": "parent-session",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            self.activate_root(ctx, "parent-session")
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="parent-session",
                parent_turn_id="parent-turn",
                parent_subagent_id=None,
                child_session_id="child-session",
                child_subagent_id="sa-0-abcd1234",
                child_role="leaf",
                child_model="gpt-test",
                child_goal="g" * 5000,
            )
            ctx.hooks["subagent_stop"](
                parent_session_id="parent-session",
                parent_turn_id="parent-turn",
                parent_subagent_id=None,
                child_session_id="child-session",
                child_role="leaf",
                child_status="completed",
                child_summary="s" * 20000,
                duration_ms=1234,
                tool_call_history=[{"tool_name": "terminal", "arguments": "must-not-leak"}],
            )

        self.assertEqual(send.call_count, 2)
        start = json.loads(send.call_args_list[0].args[0].data)
        stop = json.loads(send.call_args_list[1].args[0].data)
        self.assertEqual(start["payload"]["hook_event_name"], "subagent_start")
        self.assertEqual(start["payload"]["parent_session_id"], "parent-session")
        self.assertEqual(start["payload"]["root_session_id"], "parent-session")
        self.assertEqual(start["payload"]["child_subagent_id"], "sa-0-abcd1234")
        self.assertEqual(start["payload"]["child_model"], "gpt-test")
        self.assertEqual(len(start["payload"]["child_goal"]), 4000)
        self.assertEqual(stop["payload"]["hook_event_name"], "subagent_stop")
        self.assertEqual(stop["payload"]["child_subagent_id"], "sa-0-abcd1234")
        self.assertEqual(stop["payload"]["child_goal"], "g" * 4000)
        self.assertEqual(stop["payload"]["child_status"], "completed")
        self.assertEqual(stop["payload"]["duration_ms"], 1234)
        self.assertEqual(len(stop["payload"]["child_summary"]), 12000)
        self.assertNotIn("tool_call_history", stop["payload"])

    def test_posts_child_tool_name_as_bounded_progress_without_arguments(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
                "HERMES_SESSION_ID": "root-session",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            self.activate_root(ctx, "root-session")
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-abcd1234",
                child_goal="Do work",
            )
            ctx.hooks["pre_tool_call"](
                session_id="child-session",
                task_id="sa-0-abcd1234",
                tool_name="terminal",
                args={"command": "must-not-leak"},
            )

        self.assertEqual(send.call_count, 2)
        progress = json.loads(send.call_args_list[1].args[0].data)["payload"]
        self.assertEqual(progress["hook_event_name"], "subagent_progress")
        self.assertEqual(progress["child_subagent_id"], "sa-0-abcd1234")
        self.assertEqual(progress["latest_activity"], "Using terminal")
        self.assertNotIn("args", progress)
        self.assertNotIn("command", json.dumps(progress))

    def test_progress_keeps_nested_parent_and_stop_is_monotonic(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
                "HERMES_SESSION_ID": "root-session",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            ctx.hooks["on_session_start"](session_id="root-session", platform="cli")
            os.environ["HERMES_SESSION_ID"] = "root-session"
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="parent-child-session",
                child_subagent_id="sa-0-parent",
            )
            ctx.hooks["subagent_start"](
                parent_session_id="parent-child-session",
                parent_subagent_id="sa-0-parent",
                child_session_id="nested-session",
                child_subagent_id="sa-0-nested",
            )
            ctx.hooks["pre_tool_call"](
                session_id="nested-session",
                task_id="sa-0-nested",
                tool_name="terminal",
            )
            ctx.hooks["subagent_stop"](
                parent_session_id="parent-child-session",
                child_session_id="nested-session",
                child_status="completed",
            )
            ctx.hooks["pre_tool_call"](
                session_id="nested-session",
                task_id="sa-0-nested",
                tool_name="web_search",
            )
            ctx.hooks["subagent_start"](
                parent_session_id="parent-child-session",
                parent_subagent_id="sa-0-parent",
                child_session_id="nested-session",
                child_subagent_id="sa-0-nested",
            )

        payloads = [json.loads(call.args[0].data)["payload"] for call in send.call_args_list]
        nested_start, progress, stop = payloads[2:5]
        self.assertEqual(progress["parent_subagent_id"], "sa-0-parent")
        self.assertLess(nested_start["child_sequence"], progress["child_sequence"])
        self.assertLess(progress["child_sequence"], stop["child_sequence"])
        self.assertEqual(len(payloads), 5)

    def test_root_reset_invalidates_old_child_registry(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
                "HERMES_SESSION_ID": "mutable-ambient-value",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            ctx.hooks["on_session_start"](session_id="root-a", platform="cli")
            os.environ["HERMES_SESSION_ID"] = "root-a"
            ctx.hooks["subagent_start"](
                parent_session_id="root-a",
                child_session_id="child-a",
                child_subagent_id="sa-0-reused",
            )
            ctx.hooks["on_session_reset"](session_id="root-b", platform="cli")
            os.environ["HERMES_SESSION_ID"] = "root-b"
            ctx.hooks["pre_tool_call"](
                session_id="child-a",
                task_id="sa-0-reused",
                tool_name="terminal",
            )
            ctx.hooks["subagent_stop"](
                parent_session_id="root-a",
                child_session_id="child-a",
                child_status="completed",
            )
            ctx.hooks["subagent_start"](
                parent_session_id="root-b",
                child_session_id="child-b",
                child_subagent_id="sa-0-reused",
            )

        payloads = [json.loads(call.args[0].data)["payload"] for call in send.call_args_list]
        self.assertEqual([p["hook_event_name"] for p in payloads], [
            "on_session_start", "subagent_start", "on_session_reset", "subagent_start",
        ])
        self.assertEqual(payloads[1]["root_session_id"], "root-a")
        self.assertEqual(payloads[3]["root_session_id"], "root-b")

    def test_subagent_pre_llm_call_cannot_replace_root_context(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(os.environ, {
            "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
            "CATE_HOOK_TOKEN": "secret-token",
            "CATE_TERMINAL_ID": "term-1",
        }, clear=False), patch.object(plugin._OPENER, "open", return_value=response) as send:
            self.activate_root(ctx, "root-session")
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-background",
            )
            send.reset_mock()
            ctx.hooks["pre_llm_call"](session_id="child-session", platform="subagent")
            ctx.hooks["pre_tool_call"](
                session_id="child-session", task_id="sa-0-background", tool_name="terminal",
            )

        payloads = [json.loads(call.args[0].data)["payload"] for call in send.call_args_list]
        self.assertEqual([p["hook_event_name"] for p in payloads], ["subagent_progress"])
        self.assertEqual(payloads[0]["root_session_id"], "root-session")

    def test_parent_turn_end_does_not_orphan_a_background_child(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            self.activate_root(ctx, "root-session")
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-background",
            )
            ctx.hooks["on_session_end"](session_id="root-session", platform="cli")
            ctx.hooks["subagent_stop"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_status="completed",
            )

        payloads = [json.loads(call.args[0].data)["payload"] for call in send.call_args_list]
        self.assertEqual([p["hook_event_name"] for p in payloads], [
            "subagent_start", "on_session_end", "subagent_stop",
        ])

    def test_resumed_session_uses_pre_llm_call_as_root_context(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            ctx.hooks["pre_llm_call"](
                session_id="resumed-root", platform="cli", model="gpt-resumed",
            )
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="resumed-root",
                child_session_id="child-session",
                child_subagent_id="sa-0-resumed",
            )

        payload = json.loads(send.call_args.args[0].data)["payload"]
        self.assertEqual(payload["root_session_id"], "resumed-root")
        self.assertNotIn("child_model", payload)

    def test_caps_children_per_root_session(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            self.activate_root(ctx, "root-session")
            send.reset_mock()
            for index in range(plugin._MAX_SUBAGENTS_PER_ROOT + 1):
                ctx.hooks["subagent_start"](
                    parent_session_id="root-session",
                    child_session_id=f"child-{index}",
                    child_subagent_id=f"sa-0-child{index}",
                )

        self.assertEqual(send.call_count, plugin._MAX_SUBAGENTS_PER_ROOT)

    def test_delayed_progress_reserved_before_stop_cannot_post_after_stop(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        delayed = []

        def delayed_open(request, timeout):
            payload = json.loads(request.data)["payload"]
            if payload["hook_event_name"] == "subagent_progress":
                delayed.append(payload)
            return response

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", side_effect=delayed_open) as send:
            self.activate_root(ctx, "root-session")
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-racy",
            )
            with plugin._SUBAGENT_LOCK:
                reserved = plugin._reserve_subagent_progress({
                    "session_id": "child-session",
                    "task_id": "sa-0-racy",
                    "tool_name": "terminal",
                })
            ctx.hooks["subagent_stop"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_status="completed",
            )
            self.assertFalse(plugin._report_reserved_progress(profile="work", reserved=reserved))

        self.assertEqual(delayed, [])

    def test_subagent_lifecycle_requires_the_root_cli_session(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
                "HERMES_SESSION_ID": "root-session",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["on_session_start"](session_id="root-session", platform="cli")
            os.environ["HERMES_SESSION_ID"] = "root-session"
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="different-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-abcd1234",
                child_goal="Do work",
            )
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-abcd1234",
                child_goal="Do work",
            )

        send.assert_called_once()

    def test_accepts_nested_subagent_from_a_known_parent(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
                "HERMES_SESSION_ID": "root-session",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            self.activate_root(ctx, "root-session")
            send.reset_mock()
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="sa-0-parent",
                child_goal="Coordinate",
            )
            ctx.hooks["subagent_start"](
                parent_session_id="child-session",
                parent_subagent_id="sa-0-parent",
                child_session_id="grandchild-session",
                child_subagent_id="sa-0-child",
                child_goal="Investigate",
            )

        self.assertEqual(send.call_count, 2)
        nested = json.loads(send.call_args_list[1].args[0].data)["payload"]
        self.assertEqual(nested["root_session_id"], "root-session")
        self.assertEqual(nested["parent_session_id"], "child-session")

    def test_drops_malformed_subagent_identity(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["subagent_start"](
                parent_session_id="root-session",
                child_session_id="child-session",
                child_subagent_id="bad id with spaces",
                child_goal="Do work",
            )

        send.assert_not_called()

    def test_posts_authenticated_profile_scoped_payload(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open", return_value=response) as send:
            ctx.hooks["pre_llm_call"](
                session_id="20260911_131500_abcd1234",
                platform="cli",
                model="test-model",
            )

        request = send.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:43210")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        body = json.loads(request.data)
        self.assertEqual(body["agentId"], "hermes")
        self.assertEqual(body["terminalId"], "term-1")
        self.assertEqual(body["pid"], os.getpid())
        self.assertRegex(body["processStartedAt"], r"^[1-9][0-9]*$")
        self.assertEqual(
            body["payload"],
            {
                "hook_event_name": "pre_llm_call",
                "session_id": "20260911_131500_abcd1234",
                "cwd": os.getcwd(),
                "profile": "work",
                "platform": "cli",
                "reason": None,
            },
        )

    def test_is_silent_without_cate_environment(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in {"CATE_HOOK_ENDPOINT", "CATE_HOOK_TOKEN", "CATE_TERMINAL_ID"}
        }

        with patch.dict(os.environ, env, clear=True), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["on_session_start"](session_id="session-1", platform="cli")

        send.assert_not_called()

    def test_drops_noninteractive_surfaces(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["pre_llm_call"](session_id="child-1", platform="subagent")

        send.assert_not_called()

    def test_drops_custom_profiles_that_cannot_be_resumed_safely(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext(profile_name="custom")
        plugin.register(ctx)

        with patch.dict(
            os.environ,
            {
                "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210",
                "CATE_HOOK_TOKEN": "secret-token",
                "CATE_TERMINAL_ID": "term-1",
            },
            clear=False,
        ), patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["pre_llm_call"](session_id="session-1", platform="cli")

        send.assert_not_called()

    def test_rejects_non_loopback_endpoint_and_swallows_transport_failures(self) -> None:
        plugin = load_plugin()
        ctx = FakeContext()
        plugin.register(ctx)
        base_env = {
            "CATE_HOOK_TOKEN": "secret-token",
            "CATE_TERMINAL_ID": "term-1",
        }

        with patch.dict(os.environ, {**base_env, "CATE_HOOK_ENDPOINT": "https://example.com/hook"}, clear=False), \
                patch.object(plugin._OPENER, "open") as send:
            ctx.hooks["on_session_start"](session_id="session-1", platform="cli")
            send.assert_not_called()

        with patch.dict(os.environ, {**base_env, "CATE_HOOK_ENDPOINT": "http://127.0.0.1:43210"}, clear=False), \
                patch.object(plugin._OPENER, "open", side_effect=OSError("offline")):
            ctx.hooks["on_session_start"](session_id="session-1", platform="cli")


if __name__ == "__main__":
    unittest.main()
