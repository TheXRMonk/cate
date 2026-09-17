// =============================================================================
// Session persistence round-trip — SessionSnapshot → on-disk project files
// (.cate/workspace.json + .cate/session.json, through real JSON) → snapshot.
// Builds the dock layout and canvas geometry with the REAL dockStore /
// canvasStore so this exercises the same shapes saveSession persists, and
// asserts the shareable / machine-local split: workspace.json carries no
// absolute paths, scratch content, or worktree tags; session.json carries
// exactly those and nothing for panels that have none.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  buildWorkspaceFile,
  buildSessionFile,
  projectFilesToSnapshot,
  collectPanelIdsFromDockState,
} from './sessionSerialize'
import { createDockStore } from '../../stores/dockStore'
import { createCanvasStore } from '../../stores/canvasStore'
import { editorDraftPath, isEditorDraft } from '../../../shared/editorDraft'
import type {
  SessionSnapshot,
  PanelState,
  DetachedDockWindowSnapshot,
  CanvasSnapshot,
} from '../../../shared/types'

const ROOT = '/Users/dev/my-repo'
const WORKTREE_PATH = `${ROOT}/.cate/worktrees/fix-login`

function panel(p: Partial<PanelState> & Pick<PanelState, 'id' | 'type'>): PanelState {
  return { title: p.id, isDirty: false, ...p }
}

/** Build a realistic snapshot: a center canvas holding two editors, a bottom
 *  dock with a browser | terminal split, plus worktree + remote metadata. */
function buildSnapshot(): { snapshot: SessionSnapshot; canvasSnapshot: CanvasSnapshot } {
  // Dock layout via the real dock store.
  const dock = createDockStore()
  dock.getState().dockPanel('canvas-1', 'center')
  dock.getState().dockPanel('web-1', 'bottom')
  const webStack = dock.getState().getPanelLocation('web-1')!
  dock.getState().dockPanel('term-1', 'bottom', {
    type: 'split',
    stackId: webStack.type === 'dock' ? webStack.stackId : '',
    edge: 'right',
  })
  const dockState = dock.getState().getSnapshot()

  // Canvas geometry via the real canvas store.
  const canvas = createCanvasStore()
  canvas.getState().addNode('ed-1', 'editor', { x: 100, y: 80 }, { width: 600, height: 400 })
  canvas.getState().addNode('ed-scratch', 'editor', { x: 900, y: 80 }, { width: 500, height: 300 })
  canvas.getState().setZoomAndOffset(0.8, { x: -120, y: 40 })
  const canvasSnapshot: CanvasSnapshot = {
    id: 'canvas-1',
    canvasNodes: canvas.getState().nodes,
    zoomLevel: canvas.getState().zoomLevel,
    viewportOffset: canvas.getState().viewportOffset,
  }

  const snapshot: SessionSnapshot = {
    workspaceId: 'ws-uuid-1',
    workspaceName: 'My Repo',
    rootPath: ROOT,
    dockState,
    panels: {
      'canvas-1': panel({ id: 'canvas-1', type: 'canvas' }),
      'ed-1': panel({ id: 'ed-1', type: 'editor', filePath: `${ROOT}/src/app.ts` }),
      'ed-scratch': panel({ id: 'ed-scratch', type: 'editor', unsavedContent: 'SCRATCH-CONTENT' }),
      'term-1': panel({ id: 'term-1', type: 'terminal', worktreeId: 'wt-1' }),
      'web-1': panel({
        id: 'web-1',
        type: 'browser',
        tabs: [
          { id: 'tab-1', url: 'https://docs.example', title: 'Docs' },
          { id: 'tab-2', url: 'http://localhost:3000', title: 'App' },
        ],
        activeTabId: 'tab-2',
        proxyUrl: 'http://user:pass@proxy:8080',
      }),
    },
    panelRelations: [{
      id: 'relation-1',
      fromPanelId: 'term-1',
      toPanelId: 'web-1',
      kind: 'use',
      label: 'summarizes findings from',
    }],
    canvases: { 'canvas-1': canvasSnapshot },
    terminalCwds: { 'term-1': WORKTREE_PATH },
    worktrees: [{ id: 'wt-1', path: WORKTREE_PATH, color: '#ff5555', label: 'fix-login' }],
    connection: {
      kind: 'server',
      runtimeId: 'comp-1',
      host: 'devbox',
      user: 'anton',
      remotePath: '/srv/my-repo',
    },
    worktreeViewScopes: {
      navigationWorktreeId: 'wt-1',
      sourceControlWorktreeByRepository: { [ROOT]: 'wt-1' },
    },
  }
  return { snapshot, canvasSnapshot }
}

/** Simulate the disk: serialize to JSON text and parse back, like a real save/load. */
function throughDisk<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

describe('workspace.json + session.json round-trip', () => {
  it('restores an equivalent snapshot through real JSON serialization', () => {
    const { snapshot, canvasSnapshot } = buildSnapshot()

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, '#00ff00'))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    expect(wsFile.panels!['web-1']).not.toHaveProperty('url')
    expect(wsFile.panels!['web-1'].tabs).toEqual(snapshot.panels!['web-1'].tabs)

    // Identity + reconnect metadata.
    expect(restored.workspaceId).toBe('ws-uuid-1')
    expect(restored.workspaceName).toBe('My Repo')
    expect(restored.rootPath).toBe(ROOT)
    expect(restored.connection).toEqual(snapshot.connection)
    expect(restored.worktrees).toEqual(snapshot.worktrees)
    expect(restored.worktreeViewScopes).toEqual(snapshot.worktreeViewScopes)

    // Every placed panel comes back, with machine-local facts re-attached.
    expect(Object.keys(restored.panels!).sort()).toEqual(
      Object.keys(snapshot.panels!).sort(),
    )
    expect(restored.panels!['ed-1'].filePath).toBe(`${ROOT}/src/app.ts`)
    expect(restored.panels!['ed-scratch'].unsavedContent).toBe('SCRATCH-CONTENT')
    expect(restored.panels!['term-1'].worktreeId).toBe('wt-1')
    expect(restored.panels!['web-1'].tabs).toEqual(snapshot.panels!['web-1'].tabs)
    expect(restored.panels!['web-1'].activeTabId).toBe('tab-2')
    expect(restored.panels!['web-1'].proxyUrl).toBe('http://user:pass@proxy:8080')
    expect(restored.terminalCwds).toEqual({ 'term-1': WORKTREE_PATH })
    expect(restored.panelRelations).toEqual(snapshot.panelRelations)

    // Dock layout and canvas geometry survive byte-for-byte.
    expect(restored.dockState).toEqual(throughDisk(snapshot.dockState))
    expect(restored.canvases).toEqual(throughDisk({ 'canvas-1': canvasSnapshot }))
    expect(collectPanelIdsFromDockState(restored.dockState!.zones).sort()).toEqual([
      'canvas-1',
      'term-1',
      'web-1',
    ])
  })

  it('keeps machine-local facts OUT of the committed workspace.json', () => {
    const { snapshot } = buildSnapshot()

    const wsText = JSON.stringify(buildWorkspaceFile(snapshot, ROOT, ''))

    // No absolute paths — the editor's file is stored relative to the root.
    expect(wsText).not.toContain(ROOT)
    expect(wsText).toContain('"src/app.ts"')
    // No scratch buffers, worktree tags, or terminal cwds.
    expect(wsText).not.toContain('SCRATCH-CONTENT')
    expect(wsText).not.toContain('wt-1')
    expect(wsText).not.toContain('workingDirectory')
    expect(wsText).not.toContain('worktreeViewScopes')
    expect(wsText).not.toContain('relation-1')
  })

  it('keeps shareable metadata OUT of session.json and skips panels with no machine-local facts', () => {
    const { snapshot } = buildSnapshot()

    const sessFile = buildSessionFile(snapshot)

    // Only the terminal (cwd + worktree) and the scratch editor have session facts.
    expect(Object.keys(sessFile.panels).sort()).toEqual(['ed-scratch', 'term-1'])
    expect(sessFile.panels['term-1']).toEqual({
      panelId: 'term-1',
      workingDirectory: WORKTREE_PATH,
      unsavedContent: undefined,
      worktreeId: 'wt-1',
    })
    const sessText = JSON.stringify(sessFile)
    expect(sessFile.worktreeViewScopes).toEqual(snapshot.worktreeViewScopes)
    expect(sessFile.panelRelations).toEqual(snapshot.panelRelations)
    expect(sessText).not.toContain('src/app.ts')
    expect(sessText).not.toContain('localhost:3000')
  })

  it('round-trips a terminal agent-session stamp through session.json only', () => {
    const { snapshot } = buildSnapshot()
    const agentSession = {
      agentId: 'hermes',
      sessionId: '20260911_131500_abcd1234',
      cwd: WORKTREE_PATH,
      profile: 'work',
    }
    snapshot.panels!['term-1'] = { ...snapshot.panels!['term-1'], agentSession }

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    // The stamp survives restore (TerminalPanel consumes it to type the resume
    // command) but never reaches the committed workspace.json — session ids
    // reference stores on this machine's runtime host.
    expect(restored.panels!['term-1'].agentSession).toEqual(agentSession)
    expect(JSON.stringify(wsFile)).not.toContain(agentSession.sessionId)
  })

  it('round-trips Cate-owned run metadata but never its one-shot launch', () => {
    const { snapshot } = buildSnapshot()
    const codingAgentRun = {
      id: 'run-1',
      agentId: 'codex' as const,
      panelId: 'term-1',
      ownerPanelId: 'agent-1',
      prompt: 'Implement the parser',
      createdAt: 123,
      worktreeId: 'wt-1',
      followUps: [{ prompt: 'Add the edge-case test', sentAt: 456 }],
    }
    snapshot.panels!['term-1'] = {
      ...snapshot.panels!['term-1'],
      codingAgentRun,
      codingAgentLaunch: {
        runId: 'run-1',
        agentId: 'codex',
        prompt: 'Implement the parser',
        ownerPanelId: 'agent-1',
      },
    }

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    expect(restored.panels!['term-1'].codingAgentRun).toEqual(codingAgentRun)
    expect(restored.panels!['term-1'].codingAgentLaunch).toBeUndefined()
    expect(JSON.stringify(wsFile)).not.toContain('Implement the parser')
  })

  it('keeps Hermes child details machine-local and marks a running child unavailable after restart', () => {
    const { snapshot } = buildSnapshot()
    const hermesSubagent = {
      id: 'sa-0-abcd1234',
      parentPanelId: 'term-1',
      parentTerminalId: 'pty-parent',
      rootSessionId: 'root-session',
      parentSessionId: 'root-session',
      sessionId: 'child-session',
      profile: 'work',
      role: 'leaf',
      goal: 'Inspect private implementation details',
      status: 'running' as const,
      createdAt: 100,
      updatedAt: 200,
    }
    snapshot.panels!['hermes-child'] = {
      id: 'hermes-child',
      type: 'hermes-subagent',
      title: 'Hermes task 1',
      isDirty: false,
      hermesSubagent,
    }
    snapshot.canvases!['canvas-1'].canvasNodes.child = {
      id: 'child', origin: { x: 0, y: 0 }, size: { width: 600, height: 420 },
      zOrder: 1, creationIndex: 1,
      dockLayout: { type: 'tabs', id: 'child-tabs', panelIds: ['hermes-child'], activeIndex: 0 },
    }

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    expect(JSON.stringify(wsFile)).not.toContain(hermesSubagent.goal)
    expect(wsFile.panels).not.toHaveProperty('hermes-child')
    expect(JSON.stringify(wsFile)).not.toContain('hermes-subagent')
    expect(sessFile.localPanels!['hermes-child'].hermesSubagent).toEqual(hermesSubagent)
    expect(sessFile.localCanvases!['canvas-1'].canvasNodes).toHaveProperty('child')
    expect(JSON.stringify(sessFile.localCanvases)).not.toContain('term-1')
    expect(sessFile.panels['hermes-child'].hermesSubagent).toEqual(hermesSubagent)
    expect(restored.panels!['hermes-child'].hermesSubagent).toEqual({
      ...hermesSubagent,
      status: 'unavailable',
    })
    expect(restored.canvases!['canvas-1'].canvasNodes).toHaveProperty('child')
  })

  it('drops machine-local Hermes child geometry when its session sidecar is absent', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!['hermes-child'] = panel({
      id: 'hermes-child',
      type: 'hermes-subagent',
      hermesSubagent: {
        id: 'sa-0-abcd1234', parentPanelId: 'term-1', parentTerminalId: 'pty-parent', rootSessionId: 'root-session', parentSessionId: 'root-session',
        status: 'completed', summary: 'Done', createdAt: 100, updatedAt: 200,
      },
    })
    snapshot.canvases!['canvas-1'].canvasNodes.child = {
      id: 'child', origin: { x: 0, y: 0 }, size: { width: 600, height: 420 },
      zOrder: 1, creationIndex: 1,
      dockLayout: { type: 'tabs', id: 'child-tabs', panelIds: ['hermes-child'], activeIndex: 0 },
    }

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const restored = projectFilesToSnapshot(wsFile, null, ROOT)

    expect(restored.panels).not.toHaveProperty('hermes-child')
    expect(restored.canvases!['canvas-1'].canvasNodes).not.toHaveProperty('child')
  })

  it('drops stale local children and geometry when their parent is missing', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!.ghost = panel({ id: 'ghost', type: 'editor' })
    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    sessFile.localPanels = {
      ghost: panel({
        id: 'ghost', type: 'hermes-subagent', hermesSubagent: {
          id: 'sa-0-ghost', parentPanelId: 'missing-parent', parentTerminalId: 'pty',
          rootSessionId: 'root', parentSessionId: 'root', status: 'running', createdAt: 1, updatedAt: 1,
        },
      }),
    }
    sessFile.localCanvases = {
      'canvas-1': {
        id: 'canvas-1', zoomLevel: 1, viewportOffset: { x: 0, y: 0 },
        canvasNodes: { ghostNode: {
          id: 'ghostNode', origin: { x: 0, y: 0 }, size: { width: 1, height: 1 }, zOrder: 1, creationIndex: 1,
          dockLayout: { type: 'tabs', id: 'ghost-tabs', panelIds: ['ghost'], activeIndex: 0 },
        } },
      },
    }

    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)
    expect(restored.panels!['ghost'].type).toBe('editor')
    expect(restored.panels!['ghost'].hermesSubagent).toBeUndefined()
    expect(restored.canvases!['canvas-1'].canvasNodes).not.toHaveProperty('ghostNode')
  })

  it('does not let local child geometry overwrite a shared canvas node', () => {
    const { snapshot } = buildSnapshot()
    const sharedNodeId = Object.keys(snapshot.canvases!['canvas-1'].canvasNodes)[0]
    const originalNode = throughDisk(snapshot.canvases!['canvas-1'].canvasNodes[sharedNodeId])
    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    sessFile.localPanels = {
      child: panel({
        id: 'child', type: 'hermes-subagent', hermesSubagent: {
          id: 'sa-0-child', parentPanelId: 'term-1', parentTerminalId: 'pty',
          rootSessionId: 'root', parentSessionId: 'root', status: 'completed', createdAt: 1, updatedAt: 2,
        },
      }),
    }
    sessFile.localCanvases = {
      'canvas-1': {
        id: 'canvas-1', zoomLevel: 9, viewportOffset: { x: 999, y: 999 },
        canvasNodes: { [sharedNodeId]: {
          ...originalNode,
          origin: { x: 999, y: 999 },
          dockLayout: { type: 'tabs', id: 'child-tabs', panelIds: ['child'], activeIndex: 0 },
        } },
      },
    }

    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)
    expect(restored.canvases!['canvas-1'].canvasNodes[sharedNodeId]).toEqual(originalNode)
  })

  it('does not persist child text when the machine-local sidecar is tracked', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!['hermes-child'] = panel({
      id: 'hermes-child', type: 'hermes-subagent',
      hermesSubagent: {
        id: 'sa-0-abcd1234', parentPanelId: 'term-1', parentTerminalId: 'pty-parent',
        rootSessionId: 'root-session', parentSessionId: 'root-session', goal: 'secret goal', summary: 'secret summary',
        status: 'completed', createdAt: 100, updatedAt: 200,
      },
    })

    const session = buildSessionFile(snapshot, undefined, { persistHermesSubagentDetails: false })
    expect(session.panels['hermes-child'].hermesSubagent).toMatchObject({
      id: 'sa-0-abcd1234', status: 'completed',
    })
    expect(session.localPanels!['hermes-child'].hermesSubagent).toMatchObject({
      id: 'sa-0-abcd1234', status: 'completed',
    })
    expect(JSON.stringify(session)).not.toContain('secret goal')
    expect(JSON.stringify(session)).not.toContain('secret summary')
  })

  it('drops user-declared relations involving generated child panels from persistence', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!['hermes-child'] = panel({
      id: 'hermes-child', type: 'hermes-subagent',
      hermesSubagent: {
        id: 'sa-0-abcd1234', parentPanelId: 'term-1', parentTerminalId: 'pty-parent',
        rootSessionId: 'root-session', parentSessionId: 'root-session',
        status: 'completed', createdAt: 100, updatedAt: 200,
      },
    })
    snapshot.panelRelations!.push({
      id: 'local-relation', fromPanelId: 'term-1', toPanelId: 'hermes-child', kind: 'use',
    })

    expect(buildSessionFile(snapshot).panelRelations?.map((relation) => relation.id))
      .toEqual(['relation-1'])
  })

  it('round-trips review state and notes through machine-local session.json only', () => {
    const { snapshot } = buildSnapshot()
    const reviewState = {
      repoPath: ROOT,
      spec: { kind: 'branch' as const, base: 'main', target: 'feature' },
      display: { split: true, wordDiff: true, wrap: false, fullFile: false, advancedPreview: true },
      collapsedFiles: ['src/large.ts'],
      notes: [{
        id: 'note-1',
        path: 'src/app.ts',
        side: 'new' as const,
        line: 42,
        body: 'Please cover this branch.',
        context: 'if (ready) {',
        contextHash: '92aec6c2',
        resolvedBase: 'abc',
        resolvedTarget: 'def',
        createdAt: '2026-09-02T12:00:00.000Z',
      }],
    }
    snapshot.panels!['review-1'] = panel({ id: 'review-1', type: 'review', reviewState })

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT, ''))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    expect(wsFile.panels!['review-1']).not.toHaveProperty('reviewState')
    expect(sessFile.panels['review-1'].reviewState).toEqual(reviewState)
    expect(restored.panels!['review-1'].reviewState).toEqual(reviewState)
  })

  it('a file outside the workspace root keeps its absolute path through the round trip', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!['ed-out'] = panel({
      id: 'ed-out',
      type: 'editor',
      filePath: '/etc/hosts',
    })

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const restored = projectFilesToSnapshot(wsFile, null, ROOT)

    expect(restored.panels!['ed-out'].filePath).toBe('/etc/hosts')
  })

  it('stores a worktree editor as a portable repo-relative path and restores its checkout', () => {
    const { snapshot } = buildSnapshot()
    const siblingCheckout = '/Users/dev/checkouts/fix-login'
    snapshot.worktrees = [
      { id: 'primary', path: ROOT, color: '#3366ff' },
      { id: 'wt-sibling', path: siblingCheckout, color: '#ff5555' },
    ]
    snapshot.panels!['ed-worktree'] = panel({
      id: 'ed-worktree',
      type: 'editor',
      filePath: `${siblingCheckout}/src/login.ts`,
    })

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    expect(wsFile.panels!['ed-worktree'].filePath).toBe('src/login.ts')
    expect(JSON.stringify(wsFile)).not.toContain(siblingCheckout)
    expect(sessFile.panels['ed-worktree'].worktreeId).toBe('wt-sibling')
    expect(restored.panels!['ed-worktree']).toMatchObject({
      filePath: `${siblingCheckout}/src/login.ts`,
      worktreeId: 'wt-sibling',
    })
  })

  it('restores from workspace.json alone (no session.json) without machine-local facts', () => {
    const { snapshot } = buildSnapshot()

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const restored = projectFilesToSnapshot(wsFile, null, ROOT)

    expect(restored.workspaceId).toBeUndefined()
    expect(restored.connection).toBeUndefined()
    expect(restored.worktrees).toBeUndefined()
    expect(restored.terminalCwds).toBeUndefined()
    expect(restored.panels!['term-1'].worktreeId).toBeUndefined()
    // Shareable structure still restores fully.
    expect(restored.panels!['ed-1'].filePath).toBe(`${ROOT}/src/app.ts`)
    expect(restored.dockState).toEqual(throughDisk(snapshot.dockState))
    expect(restored.canvases).toEqual(throughDisk(snapshot.canvases))
  })

  it('includes detached dock windows in session.json only when there are any', () => {
    const { snapshot } = buildSnapshot()
    expect(buildSessionFile(snapshot, []).dockWindows).toBeUndefined()

    const detachedDock = createDockStore()
    detachedDock.getState().dockPanel('term-2', 'center')
    const dw: DetachedDockWindowSnapshot = {
      dockState: detachedDock.getState().getSnapshot(),
      panels: { 'term-2': panel({ id: 'term-2', type: 'terminal' }) },
      bounds: { x: 50, y: 60, width: 800, height: 600 },
      workspaceId: 'ws-uuid-1',
      terminalCwds: { 'term-2': ROOT },
      canvasStates: {},
    }

    const sessFile = throughDisk(buildSessionFile(snapshot, [dw]))
    expect(sessFile.dockWindows).toHaveLength(1)
    expect(sessFile.dockWindows![0].bounds).toEqual({ x: 50, y: 60, width: 800, height: 600 })
    expect(collectPanelIdsFromDockState(sessFile.dockWindows![0].dockState.zones)).toEqual([
      'term-2',
    ])
  })

  it('restores a bare workspace.json with no panels, canvases, or dock state', () => {
    const restored = projectFilesToSnapshot({ version: 1, name: 'Bare', color: '' }, null, ROOT)

    expect(restored.workspaceName).toBe('Bare')
    expect(restored.rootPath).toBe(ROOT)
    expect(restored.panels).toBeUndefined()
    expect(restored.canvases).toBeUndefined()
    expect(restored.dockState).toBeUndefined()
    expect(restored.terminalCwds).toBeUndefined()
  })

  it('ignores session.json entries for panels missing from workspace.json', () => {
    const { snapshot } = buildSnapshot()
    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    // A stale session.json referencing a panel that was since closed.
    const staleSess = throughDisk(buildSessionFile(snapshot))
    staleSess.panels['ghost'] = {
      panelId: 'ghost',
      workingDirectory: '/tmp/elsewhere',
      worktreeId: 'wt-stale',
    }

    const restored = projectFilesToSnapshot(wsFile, staleSess, ROOT)

    expect(restored.panels!['ghost']).toBeUndefined()
    expect(restored.terminalCwds).toEqual({ 'term-1': WORKTREE_PATH })
  })

  it('round-trips Agent worktree and thread bindings through session.json', () => {
    const { snapshot } = buildSnapshot()
    snapshot.panels!['agent-1'] = panel({
      id: 'agent-1',
      type: 'agent',
      title: 'My conversation',
      titleUserOverridden: true,
      worktreeId: 'wt-agent',
      agentThreadId: 'thread-1',
    })

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    const sessFile = throughDisk(buildSessionFile(snapshot))
    expect(sessFile.panels['agent-1']).toMatchObject({
      worktreeId: 'wt-agent',
      agentThreadId: 'thread-1',
    })
    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)
    expect(restored.panels!['agent-1']).toMatchObject({
      title: 'My conversation',
      titleUserOverridden: true,
      worktreeId: 'wt-agent',
      agentThreadId: 'thread-1',
    })
  })

  it('migrates a legacy embedded-agent panel to the T3 Agent panel', () => {
    const { snapshot } = buildSnapshot()
    const wsFile = throughDisk(buildWorkspaceFile(snapshot, ROOT))
    wsFile.panels!['legacy-agent'] = { type: 'cateAgent', title: 'Agent' }
    const sessFile = throughDisk(buildSessionFile(snapshot))
    sessFile.panels['legacy-agent'] = {
      panelId: 'legacy-agent',
      worktreeId: 'wt-agent',
    }

    const restored = projectFilesToSnapshot(wsFile, sessFile, ROOT)

    expect(restored.panels!['legacy-agent']).toMatchObject({
      type: 'agent',
      worktreeId: 'wt-agent',
    })
    expect(restored.panels!['legacy-agent'].agentThreadId).toBeUndefined()
  })

  it('a Windows-style root round-trips editor paths with native separators', () => {
    const winRoot = 'C:\\Users\\dev\\repo'
    const { snapshot } = buildSnapshot()
    snapshot.panels = {
      'ed-1': panel({ id: 'ed-1', type: 'editor', filePath: 'C:\\Users\\dev\\repo\\src\\app.ts' }),
    }

    const wsFile = throughDisk(buildWorkspaceFile(snapshot, winRoot))
    expect(wsFile.panels!['ed-1'].filePath).toBe('src/app.ts')

    const restored = projectFilesToSnapshot(wsFile, null, winRoot)
    expect(restored.panels!['ed-1'].filePath).toBe('C:\\Users\\dev\\repo\\src\\app.ts')
  })
})

it.each(['edited file', ''])('round-trips a dirty file buffer (%j) and baseline only through session.json', (content) => {
  const { snapshot } = buildSnapshot()
  snapshot.panels = { editor: panel({ id: 'editor', type: 'editor', filePath: `${ROOT}/a.ts`, isDirty: true, unsavedContent: content, editorBaseline: 'disk baseline' }) }
  const workspace = throughDisk(buildWorkspaceFile(snapshot, ROOT))
  const session = throughDisk(buildSessionFile(snapshot))
  expect(workspace.panels!.editor).not.toHaveProperty('unsavedContent')
  expect(workspace.panels!.editor).not.toHaveProperty('editorBaseline')
  const restored = projectFilesToSnapshot(workspace, session, ROOT)
  expect(restored.panels!.editor).toMatchObject({ unsavedContent: content, editorBaseline: 'disk baseline', isDirty: true })
})

it('restores the persistent working file and untitled label of a shared draft', () => {
  const { snapshot } = buildSnapshot()
  const filePath = editorDraftPath(ROOT, '12345678-1234-1234-1234-123456789abc')
  snapshot.panels!['ed-scratch'] = panel({ id: 'ed-scratch', type: 'editor', title: 'Untitled', filePath })
  const workspace = throughDisk(buildWorkspaceFile(snapshot, ROOT))
  const session = throughDisk(buildSessionFile(snapshot))
  const restored = projectFilesToSnapshot(workspace, session, ROOT).panels!['ed-scratch']
  expect(restored).toMatchObject({ title: 'Untitled', filePath, isDirty: false })
  expect(isEditorDraft(restored.filePath)).toBe(true)
})

it('round-trips Search options through machine-local session state', () => {
  const { snapshot } = buildSnapshot()
  const searchState = { rootPath: ROOT, query: 'needle', isRegex: false, matchCase: true, wholeWord: false, includes: '*.ts', excludes: '', respectIgnore: true, optionsExpanded: true }
  snapshot.panels = { editor: panel({ id: 'editor', type: 'editor', searchState }) }
  const workspace = throughDisk(buildWorkspaceFile(snapshot, ROOT))
  const session = throughDisk(buildSessionFile(snapshot))
  expect(workspace.panels!.editor).not.toHaveProperty('searchState')
  expect(projectFilesToSnapshot(workspace, session, ROOT).panels!.editor.searchState).toEqual(searchState)
})
