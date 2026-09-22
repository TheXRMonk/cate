# Hermes Agent integration

Cate can restore each terminal to the exact Hermes conversation it previously hosted. The integration uses a small Hermes plugin installed into one Hermes profile. The plugin is inert outside Cate terminals.

## Install

From the Cate checkout:

```bash
bun run hermes:integration -- install --profile work
```

Restart any running Hermes CLI after installation so it loads the plugin.

Check status:

```bash
bun run hermes:integration -- status --profile work
```

Remove it:

```bash
bun run hermes:integration -- uninstall --profile work
```

`--profile` is required. Use `--profile default` explicitly for Hermes's default profile; arbitrary custom `HERMES_HOME` layouts are not eligible for automatic restore. The installer removes any ambient `HERMES_HOME` override from its Hermes subprocesses so the selected profile always resolves under Hermes's canonical profile root.

## How it works

1. Cate places a loopback endpoint, per-terminal bearer token, and terminal ID in every PTY environment.
2. The `cate-agent-state` plugin reports root CLI lifecycle hooks to that endpoint.
3. Cate saves the Hermes session ID and canonical profile with the terminal panel.
4. A restored panel starts a fresh shell and runs `hermes --profile <profile> chat --resume <session-id>`.

Exact session IDs are used instead of bare `--continue`, so two terminals in the same directory cannot accidentally converge on the newest conversation.

## Safety and limits

- The endpoint must be loopback HTTP and is authenticated with Cate's per-terminal token.
- Processes launched inside a Cate terminal inherit that token and share the terminal's trust boundary; the token isolates terminals, not processes within one terminal.
- The plugin ignores subagent, cron, and gateway sessions.
- Hook delivery is synchronous but best-effort, with a 750 ms timeout; failures never abort the Hermes session.
- Each Hermes process supplies an ephemeral monotonic start marker so delayed events from a superseded process cannot reclaim or clear the current session stamp; the marker is never persisted.
- Cate accepts no command string from the plugin; session and profile values must be shell-safe tokens.
- Install separately for every named Hermes profile used inside Cate.
- Custom `HERMES_HOME` layouts report Hermes profile `custom` and are intentionally not stamped for automatic restore.

# Hermes terminal status

The profile-scoped `cate-agent-state` plugin sends authenticated lifecycle and status events to Cate. Outside a Cate terminal it does nothing. Install/update with the existing `scripts/hermes-integration.mjs` installer, selecting an explicit Hermes profile; do not copy over an active installation manually.

## Signals

- `pre_llm_call`: working, with the root session and turn identity.
- `pre_approval_request` / `post_approval_response`: approval attempt awaiting resolution, only for the interactive `cli` surface. Smart guardian decisions and gateway events are excluded.
- `pre_tool_call` / `post_tool_call` for `clarify`: question execution awaiting completion. This brackets the tool invocation; it is not proof that the question UI has already appeared. Validation/guardrail errors may resolve it immediately.
- `on_session_end`: response complete, interrupted, or error. This plugin hook is a turn boundary, not process exit.
- `on_session_finalize`: session end. Process presence still detects crashes/exits.

Waits require a matching root session, turn, and tool-call ID. Missing correlation fails closed (no inferred wait). Pending tools are tracked separately: resolving one cannot resume the panel while another is waiting. Tool completion clears residual waits for that tool; turn completion clears that turn. Repeated events are idempotent. The protocol sends status and correlation only, never command arguments or question text.

The CLI approval hooks do not expose a universal per-request ID. Multiple indistinguishable approvals within one tool call cannot be represented individually; the integration tracks tool-level waits. Likewise, reduced interruption events without a turn ID have weaker correlation than ordinary turn events. Explicit prompt-presented/resolved hooks with universal request IDs would be needed for exact prompt-level guarantees.

## Verification

Run `bun run test:hermes-integration`, focused agent hook/status/UI tests, and `bun run typecheck`. Build the runtime and application before Electron E2E. Run only one Cate E2E/smoke process at a time, with isolated user data, a temporary workspace, and no inherited `CATE_HARNESS_ROOT`. Never use the Cate instance hosting the development session as the test instance. Keep installed profile plugins unchanged until isolated verification has passed.
