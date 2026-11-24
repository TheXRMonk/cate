// =============================================================================
// Stamping rules for hook-pushed agent-session identity (agentSessionStamps.ts):
// per-agent resumability gating (Claude and Kiro stamp once a turn proves the
// session is persisted), the /clear rotation (clear on session-end, re-stamp
// only after the next turn), the cwd fallback for cwd-less payloads, and dedup.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHookEvent, AgentHookEventKind } from '../../shared/agentHooks'
import type { AgentId } from '../../shared/agents'
import type { Runtime } from '../runtime/types'
import type { TerminalAgentSession } from '../../shared/types'

const harness = vi.hoisted(() => ({
  info: vi.fn(),
  owner: 1 as number | undefined,
  sent: [] as Array<{ channel: string; terminalId: string; session: TerminalAgentSession | null }>,
}))

vi.mock('../logger', () => ({ default: { info: harness.info } }))

vi.mock('./terminal', () => ({
  getTerminalOwner: () => harness.owner,
}))
vi.mock('../windowRegistry', () => ({
  sendToWindow: (_windowId: number, channel: string, terminalId: string, session: TerminalAgentSession | null) => {
    harness.sent.push({ channel, terminalId, session })
  },
}))

import { ingestAgentSessionStamp, clearAgentSessionStamp, dropAgentSessionStampState } from './agentSessionStamps'

let nextCwd: string | null = '/runtime-cwd'
let getCwdCalls = 0
let pendingCwd: Array<(cwd: string | null) => void> = []
const runtime = {
  process: {
    getCwd: (_id: string) => {
      getCwdCalls++
      return new Promise<string | null>((resolve) => pendingCwd.push(resolve))
    },
  },
} as unknown as Runtime

/** Resolve every in-flight getCwd and let the .then() callbacks run. */
async function resolveCwds(): Promise<void> {
  for (const resolve of pendingCwd.splice(0)) resolve(nextCwd)
  await Promise.resolve()
  await Promise.resolve()
}

function ev(
  terminalId: string,
  agentId: AgentId,
  kind: AgentHookEventKind,
  sessionId: string | null,
  cwd?: string,
): AgentHookEvent {
  return { terminalId, agentId, kind, sessionId, cwd, raw: {} }
}

const stamps = (terminalId: string) => harness.sent.filter((s) => s.terminalId === terminalId).map((s) => s.session)

let n = 0
let tid: string

beforeEach(() => {
  harness.sent.length = 0
  harness.owner = 1
  nextCwd = '/runtime-cwd'
  getCwdCalls = 0
  pendingCwd = []
  tid = `term-${++n}` // fresh terminal per test — module state is per-terminal
})

describe('resume diagnostics', () => {
  it('refreshes diagnostic generation when an unchanged stamp is deduplicated', () => {
    const event = { ...ev(tid, 'hermes', 'turn-start', 'session-1', '/w'),
      profile: 'work', sourcePid: 42, sourceStartedAt: '100' }
    ingestAgentSessionStamp(runtime, event)
    harness.info.mockClear()
    ingestAgentSessionStamp(runtime, { ...event, sourcePid: 43, sourceStartedAt: '200' })
    expect(harness.info).not.toHaveBeenCalled()
    expect(stamps(tid)).toHaveLength(1)
    clearAgentSessionStamp(tid, 43, '200')
    expect(JSON.parse(harness.info.mock.calls[0][1])).toMatchObject({
      previous: { sessionId: 'session-1', sourcePid: 43, sourceStartedAt: '200' },
    })
  })
  it.each([
    ['session-end', 'session-1', 'session-end'],
    ['session-start', 'session-2', 'non-resumable-replacement'],
  ] as const)('distinguishes %s clears from process exits', (kind, sessionId, reason) => {
    const base = { profile: 'work', sourcePid: 42, sourceStartedAt: '100' }
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'turn-start', 'session-1', '/w'), ...base })
    harness.info.mockClear()
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', kind, sessionId, '/w'), ...base })
    expect(JSON.parse(harness.info.mock.calls[0][1])).toMatchObject({
      action: 'clear', reason, previous: { sessionId: 'session-1', ...base },
    })
  })
  it('does not log stale clears or unchanged stamps', () => {
    const event = { ...ev(tid, 'hermes', 'turn-start', 'session-1', '/w'),
      profile: 'work', sourcePid: 42, sourceStartedAt: '100' }
    ingestAgentSessionStamp(runtime, event)
    harness.info.mockClear()
    ingestAgentSessionStamp(runtime, event)
    clearAgentSessionStamp(tid, 43, '200')
    expect(harness.info).not.toHaveBeenCalled()
    expect(stamps(tid)).toHaveLength(1)
  })
  it('logs terminal teardown even after its window owner disappears', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'session-1', '/w'))
    harness.info.mockClear()
    harness.owner = undefined
    dropAgentSessionStampState(tid)
    expect(harness.info).toHaveBeenCalledWith('[session-resume] %s', expect.any(String))
    expect(JSON.parse(harness.info.mock.calls[0][1])).toMatchObject({
      action: 'drop', reason: 'terminal-teardown', terminalId: tid,
      previous: { sessionId: 'session-1' },
    })
    dropAgentSessionStampState(tid)
    expect(harness.info).toHaveBeenCalledTimes(1)
  })
  it('records a process-exit clear with the previous identity and generation', () => {
    const event = { ...ev(tid, 'hermes', 'turn-start', 'session-1', '/private-cwd'),
      profile: 'work', sourcePid: 42, sourceStartedAt: '100', raw: { token: 'secret' } }
    harness.info.mockClear()
    ingestAgentSessionStamp(runtime, event)
    const stamped = JSON.parse(harness.info.mock.calls[0][1])
    expect(stamped).toMatchObject({ action: 'stamp', next: {
      sessionId: 'session-1', profile: 'work', sourcePid: 42, sourceStartedAt: '100',
    } })
    expect(JSON.stringify(stamped)).not.toMatch(/secret|private-cwd/)
    harness.info.mockClear()
    clearAgentSessionStamp(tid, 42, '100')
    expect(harness.info).toHaveBeenCalledWith('[session-resume] %s', expect.any(String))
    const record = JSON.parse(harness.info.mock.calls[0][1])
    expect(record).toMatchObject({ action: 'clear', reason: 'process-exit', terminalId: tid,
      previous: { agentId: 'hermes', sessionId: 'session-1', profile: 'work', sourcePid: 42, sourceStartedAt: '100' },
      trigger: { sourcePid: 42, sourceStartedAt: '100' } })
    expect(JSON.stringify(record)).not.toMatch(/secret|private-cwd/)
    clearAgentSessionStamp(tid, 42, '100')
    expect(harness.info).toHaveBeenCalledTimes(1)
  })
})

describe('claude resumability gating', () => {
  it('does not stamp on session-start (no transcript exists yet — resume would fail)', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-start', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([])
  })

  it.each(['turn-start', 'turn-end', 'permission-wait'] as const)('stamps on %s', (kind) => {
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', kind, 'id-1', '/w'))
    expect(stamps(tid)).toEqual([{ agentId: 'claude-code', sessionId: 'id-1', cwd: '/w' }])
  })

  it('/clear: clears on session-end, stays cleared through the rotated session-start, re-stamps on next turn', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'turn-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-end', 'id-1', '/w'))
    // Rotation follow-up carries the NEW id but is not yet resumable.
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-start', 'id-2', '/w'))
    expect(stamps(tid)).toEqual([
      { agentId: 'claude-code', sessionId: 'id-1', cwd: '/w' },
      null, // a /clear'd-but-never-prompted session leaves the stamp CLEARED
    ])
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'turn-start', 'id-2', '/w'))
    expect(stamps(tid).at(-1)).toEqual({ agentId: 'claude-code', sessionId: 'id-2', cwd: '/w' })
  })
})

describe('kiro resumability gating', () => {
  it('waits for the first prompt before stamping the session', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'kiro', 'session-start', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([])

    ingestAgentSessionStamp(runtime, ev(tid, 'kiro', 'turn-start', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([{ agentId: 'kiro', sessionId: 'id-1', cwd: '/w' }])
  })
})

describe('hermes profile-aware resumability', () => {
  it('waits for the first turn and persists the exact profile', () => {
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'session-start', 'id-1', '/w'), profile: 'work' })
    expect(stamps(tid)).toEqual([])
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'turn-start', 'id-1', '/w'), profile: 'work' })
    expect(stamps(tid)).toEqual([{ agentId: 'hermes', sessionId: 'id-1', cwd: '/w', profile: 'work' }])
  })

  it('does not let an older finalize clear a newer profile session', () => {
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'turn-start', 'new', '/w'), profile: 'work', sourcePid: 22 })
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'session-end', 'old', '/w'), profile: 'default', sourcePid: 11 })
    expect(stamps(tid)).toEqual([{ agentId: 'hermes', sessionId: 'new', cwd: '/w', profile: 'work' }])
  })

  it('clears the old stamp when a replacement session starts, then rejects the old finalize', () => {
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'turn-start', 'old', '/w'), profile: 'default', sourcePid: 11 })
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'session-start', 'new', '/w'), profile: 'work', sourcePid: 22 })
    ingestAgentSessionStamp(runtime, { ...ev(tid, 'hermes', 'session-end', 'old', '/w'), profile: 'default', sourcePid: 11 })
    expect(stamps(tid)).toEqual([
      { agentId: 'hermes', sessionId: 'old', cwd: '/w', profile: 'default' },
      null,
    ])
  })

  it('does not let an old presence falling edge clear a newer process stamp', () => {
    ingestAgentSessionStamp(runtime, {
      ...ev(tid, 'hermes', 'turn-start', 'old', '/w'),
      profile: 'default', sourcePid: 11, sourceStartedAt: '100',
    })
    ingestAgentSessionStamp(runtime, {
      ...ev(tid, 'hermes', 'turn-start', 'new', '/w'),
      profile: 'work', sourcePid: 22, sourceStartedAt: '200',
    })
    clearAgentSessionStamp(tid, 11, '100')
    expect(stamps(tid).at(-1)).toEqual({
      agentId: 'hermes', sessionId: 'new', cwd: '/w', profile: 'work',
    })
  })
})

describe('agents whose first sessionId-bearing event is already persisted', () => {
  it.each(['codex', 'cursor', 'opencode'] as const)('%s stamps on session-start', (agentId) => {
    ingestAgentSessionStamp(runtime, ev(tid, agentId, 'session-start', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([{ agentId, sessionId: 'id-1', cwd: '/w' }])
  })

})

describe('cwd fallback (payloads that carry no cwd)', () => {
  it('stamps with the terminal cwd fetched from the runtime', async () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1'))
    expect(stamps(tid)).toEqual([]) // async — nothing until getCwd resolves
    await resolveCwds()
    expect(stamps(tid)).toEqual([{ agentId: 'codex', sessionId: 'id-1', cwd: '/runtime-cwd' }])
  })

  it('stamps with empty cwd when the runtime cannot resolve one', async () => {
    nextCwd = null
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-end', 'id-1'))
    await resolveCwds()
    expect(stamps(tid)).toEqual([{ agentId: 'codex', sessionId: 'id-1', cwd: '' }])
  })

  it('drops an in-flight cwd lookup superseded by a clear (no resurrection)', async () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1'))
    clearAgentSessionStamp(tid) // agent exited while getCwd was in flight
    await resolveCwds()
    // Only the clear went out — the late cwd result must not resurrect a stamp.
    expect(stamps(tid)).toEqual([null])
  })

  it('does not call getCwd when the event carries a cwd', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    expect(getCwdCalls).toBe(0)
  })
})

describe('emit mechanics', () => {
  it.each(['session-title', 'input-submit'] as const)('ignores %s because it does not change resume identity', (kind) => {
    ingestAgentSessionStamp(runtime, {
      ...ev(tid, 'codex', kind, 'id-1', '/w'),
      title: 'Fix terminal titles',
    })
    expect(stamps(tid)).toEqual([])
    expect(getCwdCalls).toBe(0)
  })

  it('ignores events with a null sessionId', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', null))
    expect(stamps(tid)).toEqual([])
    expect(getCwdCalls).toBe(0)
  })

  it('dedupes an unchanged stamp', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-end', 'id-1', '/w'))
    expect(stamps(tid)).toHaveLength(1)
  })

  it('sends nothing when the terminal has no owner window', () => {
    harness.owner = undefined
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    expect(harness.sent).toHaveLength(0)
  })

  it('falling-edge clear emits null; the next run re-stamps from fresh events', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    clearAgentSessionStamp(tid)
    expect(stamps(tid)).toEqual([{ agentId: 'codex', sessionId: 'id-1', cwd: '/w' }, null])
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'session-start', 'id-2', '/w'))
    expect(stamps(tid).at(-1)).toEqual({ agentId: 'codex', sessionId: 'id-2', cwd: '/w' })
  })
})
