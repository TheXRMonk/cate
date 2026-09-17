// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HermesSubagentSnapshot } from '../../../shared/hermesSubagents'
import type { WorkspaceState } from '../../../shared/types'

vi.mock('../../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    setPendingRestore: vi.fn(),
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn(() => false),
  },
}))

import { useAppStore } from '../appStore'

const workspaceId = 'workspace'
const parentPanelId = 'parent-terminal'

function workspace(): WorkspaceState {
  return {
    id: workspaceId,
    name: 'Workspace',
    color: '',
    rootPath: '/tmp/workspace',
    panels: {
      [parentPanelId]: {
        id: parentPanelId,
        type: 'terminal',
        title: 'Terminal 1',
        isDirty: false,
      },
    },
  } as WorkspaceState
}

function running(overrides: Partial<HermesSubagentSnapshot> = {}): HermesSubagentSnapshot {
  return {
    id: 'sa-0-abcd1234',
    parentPanelId,
    parentTerminalId: 'pty-parent',
    rootSessionId: 'root-session',
    parentSessionId: 'root-session',
    sessionId: 'child-session',
    role: 'leaf',
    goal: 'Review the implementation',
    status: 'running',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

describe('Hermes subagent panels', () => {
  beforeEach(() => {
    useAppStore.setState({ workspaces: [workspace()], selectedWorkspaceId: workspaceId })
  })

  it('creates one non-PTY panel and reuses it for duplicate start events', () => {
    const first = useAppStore.getState().createHermesSubagent(
      workspaceId,
      running(),
      { target: 'none' },
    )
    const second = useAppStore.getState().createHermesSubagent(
      workspaceId,
      running({ updatedAt: 200 }),
      { target: 'none' },
    )

    expect(second).toBe(first)
    expect(Object.values(useAppStore.getState().workspaces[0].panels)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: first,
        type: 'hermes-subagent',
        title: 'Hermes task 1',
        hermesSubagent: expect.objectContaining({ id: 'sa-0-abcd1234', status: 'running', updatedAt: 200 }),
      }),
    ]))
  })

  it('updates completion without changing the panel identity', () => {
    const panelId = useAppStore.getState().createHermesSubagent(
      workspaceId,
      running(),
      { target: 'none' },
    )

    useAppStore.getState().setPanelHermesSubagent(workspaceId, panelId, running({
      status: 'completed',
      summary: 'No blockers found.',
      durationMs: 1234,
      updatedAt: 200,
    }))

    expect(useAppStore.getState().workspaces[0].panels[panelId].hermesSubagent).toMatchObject({
      status: 'completed',
      summary: 'No blockers found.',
      durationMs: 1234,
    })
  })

  it('does not rewrite a terminal child through the direct store update path', () => {
    const panelId = useAppStore.getState().createHermesSubagent(
      workspaceId,
      running({ status: 'completed', sequence: 3, summary: 'first result', durationMs: 100 }),
      { target: 'none' },
    )
    useAppStore.getState().setPanelHermesSubagent(
      workspaceId,
      panelId,
      running({ status: 'failed', sequence: 4, summary: 'late rewrite', durationMs: 200 }),
    )
    expect(useAppStore.getState().workspaces[0].panels[panelId].hermesSubagent).toMatchObject({
      status: 'completed', summary: 'first result', durationMs: 100, sequence: 3,
    })
  })

  it('does not merge the same child id from a different root session', () => {
    const first = useAppStore.getState().createHermesSubagent(
      workspaceId,
      running(),
      { target: 'none' },
    )
    const second = useAppStore.getState().createHermesSubagent(
      workspaceId,
      running({ rootSessionId: 'other-root', parentSessionId: 'other-root', sessionId: 'other-child' }),
      { target: 'none' },
    )

    expect(second).not.toBe(first)
  })
})
