import { describe, expect, it } from 'vitest'
import type { AgentHookEvent } from './agentHooks'
import { mergeHermesSubagentEvent } from './hermesSubagents'

function event(
  status: 'running' | 'completed' | 'failed',
  sequence?: number,
): AgentHookEvent & { subagent: NonNullable<AgentHookEvent['subagent']> } {
  return {
    terminalId: 'pty',
    agentId: 'hermes',
    kind: status === 'running' ? 'subagent-progress' : 'subagent-stop',
    sessionId: 'root',
    raw: {},
    subagent: {
      id: 'sa-0-child',
      parentSessionId: 'root',
      status,
      sequence,
    },
  }
}

describe('mergeHermesSubagentEvent', () => {
  it('rejects unsequenced updates after a sequenced event', () => {
    const current = mergeHermesSubagentEvent(undefined, 'parent', { ...event('running', 2), profile: 'work', sourcePid: 1, sourceStartedAt: '1' }, 100)

    expect(mergeHermesSubagentEvent(current, 'parent', event('failed'), 200)).toBe(current)
  })

  it('keeps the first terminal result immutable', () => {
    const completed = event('completed', 3)
    completed.subagent.summary = 'first'
    const current = mergeHermesSubagentEvent(undefined, 'parent', completed, 100)
    const late = event('failed', 4)
    late.subagent.summary = 'late rewrite'

    expect(mergeHermesSubagentEvent(current, 'parent', late, 200)).toBe(current)
  })
})
