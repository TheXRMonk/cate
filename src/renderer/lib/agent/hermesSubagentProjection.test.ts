// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import type { WorkspaceState } from '../../../shared/types'

import { useAppStore } from '../../stores/appStore'
import { ingestHermesSubagentEvent, markHermesSubagentsUnavailable } from './hermesSubagentProjection'

const workspaceId = 'workspace'
const parentPanelId = 'parent-terminal'
const terminalId = 'pty-parent'

function event(kind: 'subagent-start' | 'subagent-progress' | 'subagent-stop', overrides: Record<string, unknown> = {}): AgentHookEvent {
  return {
    terminalId,
    agentId: 'hermes',
    kind,
    sessionId: 'root-session',
    cwd: '/tmp/workspace',
    profile: 'work',
    sourcePid: 42,
    sourceStartedAt: '100',
    raw: {},
    subagent: {
      id: 'sa-0-abcd1234',
      parentSessionId: 'root-session',
      sessionId: 'child-session',
      role: 'leaf',
      goal: 'Review the implementation',
      status: kind === 'subagent-stop' ? 'completed' : 'running',
      sequence: kind === 'subagent-stop' ? 3 : kind === 'subagent-progress' ? 2 : 1,
      ...overrides,
    },
  }
}

beforeEach(() => {
  useAppStore.setState({
    selectedWorkspaceId: workspaceId,
    workspaces: [{
      id: workspaceId,
      name: 'Workspace',
      color: '',
      rootPath: '/tmp/workspace',
      panels: {
        canvas: { id: 'canvas', type: 'canvas', title: 'Canvas', isDirty: false },
        [parentPanelId]: { id: parentPanelId, type: 'terminal', title: 'Hermes', isDirty: false },
      },
    } as WorkspaceState],
  })
})

describe('Hermes subagent projection', () => {
  it('creates one panel linked to its parent and updates it on stop', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent(event('subagent-start'), resolveParent, 100)
    ingestHermesSubagentEvent(event('subagent-start', { sequence: 2 }), resolveParent, 110)

    let workspace = useAppStore.getState().workspaces[0]
    const panels = Object.values(workspace.panels).filter((panel) => panel.type === 'hermes-subagent')
    expect(panels).toHaveLength(1)
    expect(panels[0].hermesSubagent).toMatchObject({ status: 'running', updatedAt: 110 })
    expect(panels[0].hermesSubagent?.parentPanelId).toBe(parentPanelId)

    ingestHermesSubagentEvent(event('subagent-progress', {
      latestActivity: 'Using terminal',
      sequence: 3,
    }), resolveParent, 120)
    expect(useAppStore.getState().workspaces[0].panels[panels[0].id].hermesSubagent?.latestActivity)
      .toBe('Using terminal')

    ingestHermesSubagentEvent(event('subagent-stop', {
      summary: 'No blockers found.',
      durationMs: 1234,
      sequence: 4,
    }), resolveParent, 200)

    workspace = useAppStore.getState().workspaces[0]
    expect(workspace.panels[panels[0].id].hermesSubagent).toMatchObject({
      status: 'completed',
      summary: 'No blockers found.',
      durationMs: 1234,
      updatedAt: 200,
    })

    ingestHermesSubagentEvent(event('subagent-progress', {
      latestActivity: 'Using terminal',
      sequence: 3,
    }), resolveParent, 210)
    expect(useAppStore.getState().workspaces[0].panels[panels[0].id].hermesSubagent).toMatchObject({
      status: 'completed',
      latestActivity: 'Using terminal',
      sequence: 4,
    })
  })

  it('drops an event whose terminal has no owned parent panel', () => {
    ingestHermesSubagentEvent(event('subagent-start'), () => null, 100)
    expect(Object.values(useAppStore.getState().workspaces[0].panels)
      .filter((panel) => panel.type === 'hermes-subagent')).toHaveLength(0)
  })

  it('drops malformed or unbounded events before projection', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent({ ...event('subagent-start'), subagent: null } as unknown as AgentHookEvent, resolveParent, 100)
    ingestHermesSubagentEvent(event('subagent-start', { parentSessionId: 123 }), resolveParent, 100)
    ingestHermesSubagentEvent(event('subagent-start', { goal: 'x'.repeat(4_001) }), resolveParent, 100)
    expect(Object.values(useAppStore.getState().workspaces[0].panels)
      .filter((panel) => panel.type === 'hermes-subagent')).toHaveLength(0)
  })

  it('links a nested child to its actual parent subagent panel', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent(event('subagent-start'), resolveParent, 100)
    const parent = Object.values(useAppStore.getState().workspaces[0].panels)
      .find((panel) => panel.hermesSubagent?.id === 'sa-0-abcd1234')!

    ingestHermesSubagentEvent(event('subagent-start', {
      id: 'sa-1-child5678',
      sessionId: 'grandchild-session',
      parentSessionId: 'child-session',
      parentSubagentId: 'sa-0-abcd1234',
      goal: 'Inspect one component',
    }), resolveParent, 110)

    const child = Object.values(useAppStore.getState().workspaces[0].panels)
      .find((panel) => panel.hermesSubagent?.id === 'sa-1-child5678')!
    expect(child.hermesSubagent?.parentPanelId).toBe(parent.id)

    ingestHermesSubagentEvent(event('subagent-progress', {
      id: 'sa-1-child5678',
      sessionId: 'grandchild-session',
      parentSessionId: 'child-session',
      parentSubagentId: 'sa-0-abcd1234',
      latestActivity: 'Using terminal',
      sequence: 2,
    }), resolveParent, 120)
    const updated = useAppStore.getState().workspaces[0].panels[child.id]
    expect(updated.hermesSubagent?.parentPanelId).toBe(parent.id)
    expect(updated.hermesSubagent?.latestActivity).toBe('Using terminal')
  })

  it('keeps reused child ids isolated by process generation', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent({ ...event('subagent-start'), sourcePid: 10, sourceStartedAt: '100' }, resolveParent, 100)
    ingestHermesSubagentEvent({
      ...event('subagent-start', { sessionId: 'new-child' }),
      sourcePid: 10,
      sourceStartedAt: '200',
    }, resolveParent, 200)
    expect(Object.values(useAppStore.getState().workspaces[0].panels)
      .filter((panel) => panel.type === 'hermes-subagent')).toHaveLength(2)
  })

  it('marks only the ended process generation unavailable', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent({
      ...event('subagent-start'), sourcePid: 10, sourceStartedAt: '100',
    }, resolveParent, 100)
    ingestHermesSubagentEvent({
      ...event('subagent-start', { id: 'sa-0-new', sessionId: 'new-child' }),
      sourcePid: 20, sourceStartedAt: '200',
    }, resolveParent, 110)

    markHermesSubagentsUnavailable(terminalId, 10, '100')
    const children = Object.values(useAppStore.getState().workspaces[0].panels)
      .filter((panel) => panel.type === 'hermes-subagent')
    expect(children.find((panel) => panel.hermesSubagent?.sourceStartedAt === '100')?.hermesSubagent?.status)
      .toBe('unavailable')
    expect(children.find((panel) => panel.hermesSubagent?.sourceStartedAt === '200')?.hermesSubagent?.status)
      .toBe('running')
  })

  it('does not mutate an old child when another process generation sends its stop', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent({
      ...event('subagent-start'), sourcePid: 10, sourceStartedAt: '100',
    }, resolveParent, 100)
    const oldPanel = Object.values(useAppStore.getState().workspaces[0].panels)
      .find((panel) => panel.hermesSubagent?.sourceStartedAt === '100')!
    ingestHermesSubagentEvent({
      ...event('subagent-stop', { summary: 'foreign result', sequence: 2 }),
      sourcePid: 20, sourceStartedAt: '200',
    }, resolveParent, 200)

    expect(useAppStore.getState().workspaces[0].panels[oldPanel.id].hermesSubagent?.status)
      .toBe('running')
  })

  it('caps generated child panels per root process', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    for (let index = 0; index < 65; index += 1) {
      ingestHermesSubagentEvent(event('subagent-start', {
        id: `sa-0-child${index}`,
        sessionId: `child-${index}`,
      }), resolveParent, 100 + index)
    }
    expect(Object.values(useAppStore.getState().workspaces[0].panels)
      .filter((panel) => panel.type === 'hermes-subagent')).toHaveLength(64)
  })

  it('keeps a nested child isolated from a colliding parent id in another root', () => {
    const resolveParent = () => ({ workspaceId, panelId: parentPanelId })
    ingestHermesSubagentEvent({
      ...event('subagent-start'), sourcePid: 10, sourceStartedAt: '100',
    }, resolveParent, 100)
    ingestHermesSubagentEvent({
      ...event('subagent-start', { sessionId: 'other-parent-session' }),
      sessionId: 'other-root', sourcePid: 20, sourceStartedAt: '200',
    }, resolveParent, 110)
    ingestHermesSubagentEvent({
      ...event('subagent-start', {
        id: 'sa-1-child5678', sessionId: 'nested', parentSessionId: 'child-session',
        parentSubagentId: 'sa-0-abcd1234',
      }),
      sourcePid: 10, sourceStartedAt: '100',
    }, resolveParent, 120)

    const children = Object.values(useAppStore.getState().workspaces[0].panels)
      .filter((panel) => panel.type === 'hermes-subagent')
    const oldParent = children.find((panel) => panel.hermesSubagent?.rootSessionId === 'root-session'
      && panel.hermesSubagent.id === 'sa-0-abcd1234')!
    const nested = children.find((panel) => panel.hermesSubagent?.id === 'sa-1-child5678')!
    expect(nested.hermesSubagent?.parentPanelId).toBe(oldParent.id)
  })
})
