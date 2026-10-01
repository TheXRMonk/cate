// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  applyRemoteAgentScreenState,
  resolveAgentState,
  startAgentScreenDetector,
  stopAgentScreenDetector,
  noteAgentPresence,
  noteAgentHookEvent,
  noteAgentInputSubmitted,
  forgetAgentTracker,
  canAgentReceivePrompt,
} from './agentScreenDetector'
import { sendOsNotification } from '../notifications/osNotificationSend'
vi.mock('../notifications/osNotificationSend', () => ({ sendOsNotification: vi.fn() }))
import { useStatusStore, setTerminalWorkspaceResolver } from '../../stores/statusStore'
import type { AgentHookEvent, AgentHookEventKind } from '../../../shared/agentHooks'
import type { AgentId } from '../../../shared/agents'

// Notifications reach the user through sendOsNotification; tests assert on its mock.
let notify: ReturnType<typeof vi.mocked<typeof sendOsNotification>>

describe('resolveAgentState', () => {
  it('not present, never was → notRunning', () => {
    expect(resolveAgentState({ present: false, wasPresent: false, active: false })).toBe('notRunning')
  })

  it('disappeared after being present → finished', () => {
    expect(resolveAgentState({ present: false, wasPresent: true, active: false })).toBe('finished')
  })

  it('present + active turn → running', () => {
    expect(resolveAgentState({ present: true, wasPresent: true, active: true })).toBe('running')
  })

  it('present + idle → waitingForInput', () => {
    expect(resolveAgentState({ present: true, wasPresent: true, active: false })).toBe('waitingForInput')
  })

  it('activity is ignored when the agent is gone', () => {
    expect(resolveAgentState({ present: false, wasPresent: false, active: true })).toBe('notRunning')
  })
})

// ---------------------------------------------------------------------------
// Coordinator suite — shared per-terminal harness
// ---------------------------------------------------------------------------

const WS = 'ws-1'
const PTY = 'pty-1'

function setUpCoordinator(agentId: AgentId): void {
  notify = vi.mocked(sendOsNotification); notify.mockClear()
  useStatusStore.setState({ workspaces: {} })
  // terminal->workspace identity is owned by terminalRegistry's bimap; stub
  // the resolver so the detector can map this pty to its workspace.
  setTerminalWorkspaceResolver((ptyId) => (ptyId === PTY ? WS : undefined))
  useStatusStore.getState().ensureWorkspace(WS)
  useStatusStore.getState().registerTerminal(PTY, WS)
  // agentId is owned by statusStore; the coordinator reads it at commit time.
  useStatusStore.getState().setAgentId(WS, PTY, agentId)
  startAgentScreenDetector()
}

function state(): string | undefined {
  return useStatusStore.getState().workspaces[WS]?.terminals[PTY]?.agentState
}

function hookEvent(
  kind: AgentHookEventKind,
  agentId: AgentId = 'claude-code',
  raw: Record<string, unknown> = {},
): AgentHookEvent {
  return { terminalId: PTY, agentId, kind, sessionId: 'session-1', raw }
}

describe('correlated attention', () => {
  beforeEach(() => setUpCoordinator('hermes'))
  afterEach(stopAgentScreenDetector)
  const event = (kind: AgentHookEventKind, extra: Partial<AgentHookEvent> = {}): AgentHookEvent => ({
    ...hookEvent(kind, 'hermes'), turnId: 'turn-1', ...extra,
  })
  const reason = () => useStatusStore.getState().workspaces[WS].terminals[PTY].waitingReason
  it('preserves same-turn waits and propagates reason-only changes without duplicate notifications', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(event('turn-start'))
    noteAgentHookEvent(event('wait-start', { waitingReason: 'approval' }))
    expect(reason()).toBe('approval')
    noteAgentHookEvent(event('turn-start'))
    expect(state()).toBe('waitingForInput')
    noteAgentHookEvent(event('wait-start', { waitingReason: 'question' }))
    expect(reason()).toBe('question')
    expect(notify).toHaveBeenCalledTimes(1)
    noteAgentHookEvent(event('wait-resolved'))
    expect(state()).toBe('running')
    expect(reason()).toBeUndefined()
  })
  it('requires matching active session and turn, and supersedes waits on a new turn', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(event('wait-start', { waitingReason: 'question' }))
    expect(reason()).toBeUndefined()
    noteAgentHookEvent(event('turn-start'))
    for (const extra of [{ sessionId: 'other' }, { sessionId: null }, { turnId: undefined }, { turnId: 'other' }]) {
      noteAgentHookEvent(event('wait-start', { waitingReason: 'question', ...extra }))
      expect(state()).toBe('running')
    }
    noteAgentHookEvent(event('wait-start', { waitingReason: 'question' }))
    noteAgentInputSubmitted(PTY)
    expect(state()).toBe('waitingForInput')
    noteAgentHookEvent(event('turn-start', { turnId: 'turn-2' }))
    expect(state()).toBe('running')
    noteAgentHookEvent(event('wait-start', { waitingReason: 'approval' }))
    expect(state()).toBe('running')
  })
  it('does not displace T2 with a delayed completed T1 turn-start and wait', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(event('turn-start'))
    noteAgentHookEvent(event('turn-end', { waitingReason: 'response-complete' }))
    noteAgentHookEvent(event('turn-start', { turnId: 'turn-2' }))
    notify.mockClear()

    noteAgentHookEvent(event('turn-start'))
    noteAgentHookEvent(event('wait-start', { waitingReason: 'question' }))
    expect.soft(state()).toBe('running')
    expect.soft(reason()).toBeUndefined()
    expect.soft(notify).not.toHaveBeenCalled()

    noteAgentHookEvent(event('wait-start', { turnId: 'turn-2', waitingReason: 'approval' }))
    expect(state()).toBe('waitingForInput')
    expect(reason()).toBe('approval')
    noteAgentHookEvent(event('wait-resolved', { turnId: 'turn-2' }))
    expect(state()).toBe('running')
  })
  it.each(['response-complete', 'error', 'interrupted'] as const)('records %s and suppresses interrupted notifications', (waitingReason) => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(event('turn-start'))
    noteAgentHookEvent(event('turn-end', { waitingReason, ...(waitingReason === 'interrupted' ? { interrupted: true as const } : {}) }))
    expect(reason()).toBe(waitingReason)
    expect(notify).toHaveBeenCalledTimes(waitingReason === 'interrupted' ? 0 : 1)
    noteAgentPresence(PTY, false)
    expect(reason()).toBeUndefined()
  })
  it('directly applies remote reason updates and clears them on running without notifying', () => {
    applyRemoteAgentScreenState(PTY, 'waitingForInput', 'approval')
    expect(reason()).toBe('approval')
    applyRemoteAgentScreenState(PTY, 'waitingForInput', 'question')
    expect(reason()).toBe('question')
    applyRemoteAgentScreenState(PTY, 'running', 'question')
    expect(reason()).toBeUndefined()
    applyRemoteAgentScreenState('unknown', 'waitingForInput', 'error')
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('agent activity coordinator (hook FSM + presence edges)', () => {
  beforeEach(() => setUpCoordinator('claude-code'))
  afterEach(stopAgentScreenDetector)

  it.each([
    ['automatic', 'running'],
    ['manual', 'waitingForInput'],
    ['unknown', 'running'],
  ] as const)('Codex config=%s gives %s', (approvalMode, expected) => {
    setUpCoordinator('codex')
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'codex'))
    noteAgentHookEvent({ ...hookEvent('permission-check', 'codex'), approvalMode })
    expect(state()).toBe(expected)
    expect(canAgentReceivePrompt(PTY)).toBe(false)
    expect(sendOsNotification).toHaveBeenCalledTimes(expected === 'waitingForInput' ? 1 : 0)
    if (expected === 'waitingForInput') {
      expect(sendOsNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Codex needs permission' }))
    }
    noteAgentHookEvent(hookEvent('turn-end', 'codex'))
    expect(state()).toBe('waitingForInput')
    expect(canAgentReceivePrompt(PTY)).toBe(true)
  })

  it('turn-start → running immediately; turn-end → waitingForInput + notification', () => {
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')

    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('turn-end'))
    // Authoritative event: flips immediately, no settle window.
    expect(state()).toBe('waitingForInput')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Claude Code needs input' }),
    )
  })

  it('ignores a late turn-end from the turn replaced by an in-flight follow-up', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent({ ...hookEvent('turn-start', 'codex'), turnId: 'turn-a' })
    noteAgentHookEvent({ ...hookEvent('turn-start', 'codex'), turnId: 'turn-b' })

    noteAgentHookEvent({ ...hookEvent('turn-end', 'codex'), turnId: 'turn-a' })
    expect(state()).toBe('running')
    expect(notify).not.toHaveBeenCalled()

    noteAgentHookEvent({ ...hookEvent('turn-end', 'codex'), turnId: 'turn-b' })
    expect(state()).toBe('waitingForInput')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('ignores approval and resume events arriving after their turn ended', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent({ ...hookEvent('turn-start', 'codex'), turnId: 'turn-a' })
    noteAgentHookEvent({ ...hookEvent('turn-end', 'codex'), turnId: 'turn-a' })
    for (const kind of ['permission-check', 'permission-wait', 'turn-resume'] as const) {
      noteAgentHookEvent({ ...hookEvent(kind, 'codex'), turnId: 'turn-a' })
      expect(state()).toBe('waitingForInput')
      expect(canAgentReceivePrompt(PTY)).toBe(true)
    }
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
  })

  it('a permission check cannot overwrite a confirmed human wait', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    noteAgentHookEvent(hookEvent('permission-check'))
    expect(state()).toBe('waitingForInput')
    expect(canAgentReceivePrompt(PTY)).toBe(false)
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
  })

  it('a deferred session-start cannot idle a permission check that arrived first', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('permission-check', 'codex'))
    noteAgentHookEvent(hookEvent('session-start', 'codex'))
    expect(state()).toBe('running')
    expect(canAgentReceivePrompt(PTY)).toBe(false)
    expect(sendOsNotification).not.toHaveBeenCalled()
  })

  it('presence without turn events shows waitingForInput and never notifies', () => {
    // Presence is hook-anchored daemon-side (the agent's first post registers
    // its pid), so present-with-no-TURN-events is a registered agent between
    // prompts: parked on waitingForInput — no false running, no notifications.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
    noteAgentPresence(PTY, true) // more 1 Hz scan ticks
    expect(state()).toBe('waitingForInput')
    expect(notify).not.toHaveBeenCalled()

    // The scan's falling edge still resolves its end honestly.
    noteAgentPresence(PTY, false)
    expect(state()).toBe('finished')
  })

  it('process-only presence (hooks silent) is present but neither waiting nor prompt-ready', () => {
    // codex/grok/opencode/kiro are opened from their foreground process. With
    // their hooks off, no turn event ever arrives, so idle is unknowable.
    noteAgentPresence(PTY, true, true)
    expect(state()).toBe('notRunning')
    expect(canAgentReceivePrompt(PTY)).toBe(false)
    noteAgentPresence(PTY, true, true) // more scan ticks
    expect(canAgentReceivePrompt(PTY)).toBe(false)

    // Its first hook proves it: the normal hook FSM takes over.
    noteAgentHookEvent(hookEvent('turn-start', 'codex'))
    expect(state()).toBe('running')
    noteAgentHookEvent(hookEvent('turn-end', 'codex'))
    expect(state()).toBe('waitingForInput')
    expect(canAgentReceivePrompt(PTY)).toBe(true)
    noteAgentPresence(PTY, true, true) // a lagging process-only tick keeps the proof
    expect(canAgentReceivePrompt(PTY)).toBe(true)

    // A relaunch starts unproven again.
    noteAgentPresence(PTY, false)
    noteAgentPresence(PTY, true, true)
    expect(canAgentReceivePrompt(PTY)).toBe(false)
  })

  it('session-end acts like turn-end for state but stays silent', () => {
    noteAgentPresence(PTY, true)
    expect(canAgentReceivePrompt(PTY)).toBe(true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')
    expect(canAgentReceivePrompt(PTY)).toBe(false)

    noteAgentHookEvent(hookEvent('session-end')) // e.g. /clear mid-turn
    expect(state()).toBe('waitingForInput')
    expect(canAgentReceivePrompt(PTY)).toBe(true)
    expect(notify).not.toHaveBeenCalled()
  })

  it('a new session-start resets to idle silently', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent({ ...hookEvent('session-start'), sessionId: 'session-2' })
    expect(state()).toBe('waitingForInput')
    expect(notify).not.toHaveBeenCalled()
  })

  it('a deferred session-start for the active session cannot overwrite its running turn', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'codex'))
    noteAgentHookEvent(hookEvent('session-start', 'codex'))
    expect(state()).toBe('running')
  })

  it('permission-wait mid-turn → waitingForInput + "needs permission" notification', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentHookEvent({ ...hookEvent('permission-wait'), permission: 'Claude needs your permission' })
    expect(state()).toBe('waitingForInput')
    expect(canAgentReceivePrompt(PTY)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Claude Code needs permission',
        body: 'Claude needs your permission',
      }),
    )
  })

  it('permission notification body comes from the event permission', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'codex'))
    noteAgentHookEvent({ ...hookEvent('permission-wait', 'codex'), permission: 'touch x' })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: 'touch x' }))

    // Missing detail falls back to a generic line rather than an empty body.
    noteAgentHookEvent(hookEvent('turn-start', 'opencode'))
    noteAgentHookEvent(hookEvent('permission-wait', 'opencode', {}))
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'Waiting for your approval.' }),
    )
  })

  it('turn-resume flips back to running silently; ask → resume → ask notifies per ask', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(state()).toBe('waitingForInput')
    expect(notify).toHaveBeenCalledTimes(1)

    noteAgentHookEvent(hookEvent('turn-resume'))
    expect(state()).toBe('running')
    expect(notify).toHaveBeenCalledTimes(1) // resume is silent

    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(state()).toBe('waitingForInput')
    expect(notify).toHaveBeenCalledTimes(2) // a NEW approval is due
  })

  it('submitting a permission answer resumes immediately, before PostToolUse', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'codex'))
    noteAgentHookEvent(hookEvent('permission-wait', 'codex'))
    expect(state()).toBe('waitingForInput')

    noteAgentInputSubmitted(PTY)
    expect(state()).toBe('running')
  })

  it('Codex PreToolUse keeps the sidebar running for an approved bash command', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'codex'))
    noteAgentHookEvent(hookEvent('permission-wait', 'codex'))
    expect(state()).toBe('waitingForInput')

    noteAgentHookEvent(hookEvent('turn-resume', 'codex', { hook_event_name: 'PreToolUse' }))
    expect(state()).toBe('running')

    noteAgentPresence(PTY, true)
    expect(state()).toBe('running')
  })

  it('a runtime-recovered interrupt ends the turn silently', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'kiro'))
    expect(state()).toBe('running')

    noteAgentHookEvent({ ...hookEvent('turn-end', 'kiro'), interrupted: true })
    expect(state()).toBe('waitingForInput')
    expect(notify).not.toHaveBeenCalled()
  })

  it('repeated permission-wait without a resume does not re-notify', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('turn-end after a denied permission does not double-notify', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(notify).toHaveBeenCalledTimes(1)

    // Denial produces no turn-resume — the turn just ends. State is already
    // waitingForInput, so the transition gate swallows the second ping.
    noteAgentHookEvent(hookEvent('turn-end'))
    expect(state()).toBe('waitingForInput')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('the 1 Hz presence tick cannot flip a blocked turn back to running', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(state()).toBe('waitingForInput')

    noteAgentPresence(PTY, true) // next scan tick while still blocked
    expect(state()).toBe('waitingForInput')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('presence loss mid-turn → finished, and the turn state dies with the process', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentPresence(PTY, false)
    expect(state()).toBe('finished')
    // A relaunch must start idle, not resurrect the dead turn.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
  })

  it('hook events arriving before the 1 Hz presence scan do not flip state early', () => {
    noteAgentHookEvent(hookEvent('session-start'))
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('notRunning') // presence is authoritative for existence

    noteAgentPresence(PTY, true)
    expect(state()).toBe('running') // the pending turn surfaces with presence
  })

  it('forgetAgentTracker drops the FSM memory — a re-registered terminal starts fresh', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    forgetAgentTracker(PTY)
    // Same pty id reused: the in-flight turn is gone — presence alone reads
    // idle, and the fresh-launch flip stays silent.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
    expect(notify).not.toHaveBeenCalled()
  })

  it('stopAgentScreenDetector halts state changes and clears trackers', () => {
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')

    stopAgentScreenDetector()
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput') // store untouched after stop
    expect(notify).not.toHaveBeenCalled()
  })
})
