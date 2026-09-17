// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  projectStateLoad: vi.fn(),
  recentProjectsGet: vi.fn(),
  remoteProjectsGet: vi.fn(),
  sidebarSessionGet: vi.fn(),
}))

vi.mock('../../stores/workspaceTrustStore', () => ({ ensureProjectTrusted: vi.fn(async () => true) }))
vi.mock('../logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }))

import { loadSession } from './sessionLoad'

beforeEach(() => {
  h.projectStateLoad.mockReset()
  h.recentProjectsGet.mockReset().mockResolvedValue([])
  h.remoteProjectsGet.mockReset()
  h.sidebarSessionGet.mockReset().mockResolvedValue(null)
  Object.assign(window, {
    electronAPI: {
      projectStateLoad: h.projectStateLoad,
      recentProjectsGet: h.recentProjectsGet,
      remoteProjectsGet: h.remoteProjectsGet,
      sidebarSessionGet: h.sidebarSessionGet,
      remoteProjectsSet: vi.fn(async () => {}),
      recentProjectsRemove: vi.fn(async () => {}),
    },
  })
})

describe('legacy remote snapshot restore', () => {
  it('marks a persisted running Hermes child unavailable', async () => {
    h.remoteProjectsGet.mockResolvedValue([{
      locator: 'ssh://host/repo',
      connection: { kind: 'ssh', host: 'host', user: 'dev' },
      snapshot: {
        workspaceName: 'Remote',
        rootPath: 'ssh://host/repo',
        panels: {
          parent: { id: 'parent', type: 'terminal', title: 'Hermes', isDirty: false },
          child: {
            id: 'child', type: 'hermes-subagent', title: 'Task', isDirty: false,
            hermesSubagent: {
              id: 'sa-0-child', parentPanelId: 'parent', parentTerminalId: 'pty',
              rootSessionId: 'root', parentSessionId: 'root', status: 'running',
              createdAt: 1, updatedAt: 2,
            },
          },
        },
      },
    }])

    const loaded = await loadSession()

    expect(loaded?.workspaces[0].panels?.child.hermesSubagent?.status).toBe('unavailable')
  })
})
