// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import HermesSubagentPanel from './HermesSubagentPanel'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAppStore.setState({
    selectedWorkspaceId: 'ws',
    workspaces: [{
      id: 'ws', name: 'Workspace', color: '', rootPath: '/repo',
      panels: {
        child: {
          id: 'child', type: 'hermes-subagent', title: 'Hermes task 1', isDirty: false,
          hermesSubagent: {
            id: 'sa-0-abcd1234', parentPanelId: 'parent', parentTerminalId: 'pty-parent', rootSessionId: 'root-session', parentSessionId: 'root-session',
            sessionId: 'child-session', role: 'leaf', model: 'gpt-test', goal: 'Review the implementation',
            status: 'running', createdAt: 100, updatedAt: 100,
          },
        },
      },
    } as WorkspaceState],
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('HermesSubagentPanel', () => {
  it('renders a live task without pretending it is a terminal', () => {
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('Review the implementation')
    expect(host.textContent).toContain('Running')
    expect(host.textContent).toContain('leaf')
    expect(host.textContent).toContain('gpt-test')
    expect(host.querySelector('[data-hermes-subagent-status="running"]')).not.toBeNull()
  })

  it('renders the actual model when Hermes supplies it', () => {
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('gpt-test')
    expect(host.textContent).not.toContain('Model unavailable')
  })

  it('renders unavailable instead of inferring a missing child model from the parent', () => {
    useAppStore.getState().setPanelHermesSubagent('ws', 'child', {
      ...useAppStore.getState().workspaces[0].panels.child.hermesSubagent!,
      model: undefined,
    })
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('Model unavailable')
    expect(host.textContent).not.toContain('gpt-test')
  })

  it('renders safe live activity metadata', () => {
    useAppStore.getState().setPanelHermesSubagent('ws', 'child', {
      ...useAppStore.getState().workspaces[0].panels.child.hermesSubagent!,
      latestActivity: 'Using terminal',
      updatedAt: 150,
    })
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('Using terminal')
  })

  it('renders elapsed time while a child is running', () => {
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toMatch(/\d+\.\ds/)
  })

  it('renders missing machine-local metadata as unavailable', () => {
    useAppStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => workspace.id === 'ws'
        ? { ...workspace, panels: { ...workspace.panels, child: { ...workspace.panels.child, hermesSubagent: undefined } } }
        : workspace),
    }))
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('Unavailable after restart')
  })

  it('renders the immutable completion summary', () => {
    useAppStore.getState().setPanelHermesSubagent('ws', 'child', {
      ...useAppStore.getState().workspaces[0].panels.child.hermesSubagent!,
      status: 'completed', summary: 'No blockers found.', durationMs: 1234, updatedAt: 200,
    })
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('Completed')
    expect(host.textContent).toContain('No blockers found.')
  })

  it('freezes elapsed time at the final update when duration is absent', () => {
    useAppStore.getState().setPanelHermesSubagent('ws', 'child', {
      ...useAppStore.getState().workspaces[0].panels.child.hermesSubagent!,
      status: 'completed', createdAt: 100, updatedAt: 1_600, durationMs: undefined,
    })
    act(() => root.render(<HermesSubagentPanel workspaceId="ws" panelId="child" />))
    expect(host.textContent).toContain('1.5s')
  })
})
