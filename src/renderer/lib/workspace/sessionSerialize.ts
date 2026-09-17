import { migrateNavigationPanel } from '../../../shared/panels'
// =============================================================================
// Session serialize — pure inverses between in-memory SessionSnapshot and the
// on-disk project files (.cate/workspace.json + .cate/session.json), plus the
// shared dock-state panel-id collector. No store/IPC access.
// =============================================================================

import { removedPanelIds, pruneDockState, pruneCanvasNodes } from '../../../shared/pruneRemovedPanels'
import type {
  SessionSnapshot,
  DetachedDockWindowSnapshot,
  PanelType,
  ProjectWorkspaceFile,
  ProjectSessionFile,
  ProjectPanelRef,
  ProjectSessionPanel,
  PanelState,
  WindowDockState,
} from '../../../shared/types'
import { toRelativePath, toAbsolutePath } from '../../../shared/pathUtils'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { worktreeForPanel } from '../worktreeContext'
import { restoredHermesSubagent } from '../../../shared/hermesSubagents'

// -----------------------------------------------------------------------------
// Project-local state builders (.cate/workspace.json + .cate/session.json)
// -----------------------------------------------------------------------------

// Panel fields that persist verbatim (no path relativization) in BOTH
// directions between the in-memory PanelState and the on-disk ProjectPanelRef.
// `type`/`title` are always required and `filePath` needs explicit
// relative/absolute conversion, so they're handled separately. Enumerated ONCE
// here — consulted by both buildWorkspaceFile and projectFilesToSnapshot — so
// the two paths can't drift and silently drop a field on round-trip.
const PASSTHROUGH_PANEL_FIELDS = [
  'titleUserOverridden',
  'tabs',
  'activeTabId',
  'proxyUrl',
  'sidebarView',
  'sidebarVisible',
] as const

type PassthroughPanelFields = Pick<ProjectPanelRef, (typeof PASSTHROUGH_PANEL_FIELDS)[number]>

/** Copy the passthrough panel fields (see PASSTHROUGH_PANEL_FIELDS) from a
 *  PanelState or ProjectPanelRef, normalizing null → undefined. */
function pickPassthroughPanelFields(source: PassthroughPanelFields): PassthroughPanelFields {
  const out: Record<string, unknown> = {}
  for (const key of PASSTHROUGH_PANEL_FIELDS) out[key] = source[key] ?? undefined
  return out as PassthroughPanelFields
}

export function buildWorkspaceFile(
  snapshot: SessionSnapshot,
  rootPath: string,
  color?: string,
): ProjectWorkspaceFile {
  const localOnlyPanelIds = new Set(Object.entries(snapshot.panels ?? {})
    .filter(([, panel]) => panel.type === 'hermes-subagent')
    .map(([id]) => id))
  // Shareable per-panel metadata, keyed by id. Machine-local facts (worktree
  // tag, working directory, unsaved scratch content) are excluded — they live in
  // session.json. Geometry lives in `canvases`.
  let panels: Record<string, ProjectPanelRef> | undefined
  if (snapshot.panels) {
    panels = {}
    for (const [id, p] of Object.entries(snapshot.panels)) {
      if (localOnlyPanelIds.has(id)) continue
      const worktree = worktreeForPanel(p, snapshot.worktrees ?? [])
      const pathRoot = worktree?.path ?? rootPath
      panels[id] = {
        type: p.type,
        title: p.title,
        // File identity is repository-relative in the shareable file. The
        // machine-local session binding below decides which checkout restores it.
        filePath: p.filePath ? toRelativePath(p.filePath, pathRoot) : undefined,
        ...pickPassthroughPanelFields(p),
      }
    }
  }

  return {
    version: 1,
    name: snapshot.workspaceName,
    color: color ?? '',
    dockState: pruneDockState(snapshot.dockState, localOnlyPanelIds),
    panels,
    // Geometry for every canvas (primary + secondary), keyed by canvas panel id.
    canvases: snapshot.canvases && Object.fromEntries(Object.entries(snapshot.canvases).map(([id, canvas]) => [id, {
      ...canvas,
      canvasNodes: pruneCanvasNodes(canvas.canvasNodes, localOnlyPanelIds),
    }])),
  }
}

function canonicalSubagentPanel(panel: PanelState, persistDetails: boolean): PanelState {
  if (!panel.hermesSubagent || persistDetails) return panel
  return {
    ...panel,
    hermesSubagent: {
      ...panel.hermesSubagent,
      goal: undefined,
      summary: undefined,
      latestActivity: undefined,
    },
  }
}

export function buildSessionFile(
  snapshot: SessionSnapshot,
  dockWindows?: DetachedDockWindowSnapshot[],
  options: { persistHermesSubagentDetails?: boolean } = {},
): ProjectSessionFile {
  const sanitizedDockWindows = dockWindows?.map((window) => ({
    ...window,
    panels: Object.fromEntries(Object.entries(window.panels).map(([id, panel]) => [
      id,
      canonicalSubagentPanel(panel, options.persistHermesSubagentDetails !== false),
    ])),
  }))
  const panels: Record<string, ProjectSessionPanel> = {}
  for (const p of Object.values(snapshot.panels ?? {})) {
    const workingDirectory = snapshot.terminalCwds?.[p.id]
    const worktreeId = p.worktreeId ?? worktreeForPanel(p, snapshot.worktrees ?? [])?.id
    if (
      !worktreeId &&
      !workingDirectory &&
      p.unsavedContent === undefined &&
      !p.searchState &&
      !p.agentSession &&
      !p.codingAgentRun &&
      !p.hermesSubagent &&
      !p.reviewState &&
      !p.agentThreadId
    ) continue
    panels[p.id] = {
      panelId: p.id,
      workingDirectory,
      unsavedContent: p.unsavedContent,
      editorBaseline: p.editorBaseline,
      searchState: p.searchState,
      worktreeId,
      agentSession: p.agentSession,
      codingAgentRun: p.codingAgentRun,
      hermesSubagent: canonicalSubagentPanel(p, options.persistHermesSubagentDetails !== false).hermesSubagent,
      reviewState: p.reviewState,
      agentThreadId: p.agentThreadId,
    }
  }

  return {
    version: 1,
    workspaceId: snapshot.workspaceId,
    panels,
    panelRelations: snapshot.panelRelations?.filter((relation) =>
      snapshot.panels?.[relation.fromPanelId]?.type !== 'hermes-subagent' &&
      snapshot.panels?.[relation.toPanelId]?.type !== 'hermes-subagent'),
    localPanels: Object.fromEntries(Object.entries(snapshot.panels ?? {})
      .filter(([, panel]) => panel.type === 'hermes-subagent')
      .map(([id, panel]) => [id, canonicalSubagentPanel(panel, options.persistHermesSubagentDetails !== false)])),
    localCanvases: snapshot.canvases && Object.fromEntries(
      Object.entries(snapshot.canvases)
        .map(([id, canvas]) => [id, {
          ...canvas,
          canvasNodes: Object.fromEntries(Object.entries(canvas.canvasNodes).filter(([, node]) =>
            collectPanelIds(node.dockLayout).some((panelId) => snapshot.panels?.[panelId]?.type === 'hermes-subagent'))),
        }] as const)
        .filter(([, canvas]) => Object.keys(canvas.canvasNodes).length > 0),
    ),
    dockWindows: sanitizedDockWindows?.length ? sanitizedDockWindows : undefined,
    // Worktree registry is machine-local (gitignored checkouts) — kept here, not
    // in the committed workspace.json. Paths are absolute, like workingDirectory.
    worktrees: snapshot.worktrees?.length ? snapshot.worktrees : undefined,
    worktreeViewScopes: snapshot.worktreeViewScopes,
    // Machine-local reconnect info for a remote workspace (absent ⇒ local).
    connection: snapshot.connection,
  }
}

/**
 * Convert an on-disk workspace.json (+ optional session.json) into the in-memory
 * SessionSnapshot used to rebuild a workspace. Shared by initial load and the
 * "Reload Workspace from Disk" command so the two paths can't drift.
 */
export function projectFilesToSnapshot(
  ws: ProjectWorkspaceFile,
  sess: ProjectSessionFile | null,
  rootPath: string,
): SessionSnapshot {
  const removed = removedPanelIds(ws.panels ?? {})
  // Recreate each panel record by id, merging the committed shareable metadata
  // with the machine-local session facts (worktree tag, unsaved scratch content).
  let panels: Record<string, PanelState> | undefined
  const terminalCwds: Record<string, string> = {}
  if (ws.panels) {
    panels = {}
    for (const [id, storedRef] of Object.entries(ws.panels)) {
      const ref = migrateNavigationPanel(storedRef)
      if (removed.has(id)) continue
      const sp = sess?.panels?.[id]
      // Pre-T3 layouts used the old embedded-agent discriminator.
      // panel placement while dropping all legacy embedded-chat state.
      const type = (ref.type === 'cateAgent' ? 'agent' : ref.type) as PanelType
      const pathRoot = sess?.worktrees?.find((worktree) => worktree.id === sp?.worktreeId)?.path ?? rootPath
      panels[id] = {
        id,
        type,
        title: ref.title,
        isDirty: sp?.unsavedContent !== undefined,
        filePath: ref.filePath ? toAbsolutePath(ref.filePath, pathRoot) : undefined,
        ...pickPassthroughPanelFields(ref),
        // Re-attach the machine-local facts kept out of the committed file.
        worktreeId: sp?.worktreeId ?? (['navigation', 'search'].includes(storedRef.type) ? sess?.worktreeViewScopes?.navigationWorktreeId : undefined),
        agentThreadId: type === 'agent' ? sp?.agentThreadId : undefined,
        unsavedContent: sp?.unsavedContent,
        editorBaseline: sp?.editorBaseline,
        searchState: sp?.searchState,
        // The agent session to resume in this terminal — TerminalPanel types
        // the resume command into the fresh shell and retains the stamp until
        // observed agent evidence replaces or clears it.
        agentSession: sp?.agentSession,
        codingAgentRun: sp?.codingAgentRun,
        hermesSubagent: restoredHermesSubagent(sp?.hermesSubagent),
        reviewState: sp?.reviewState,
        // Restore the per-panel cwd (worktree path / dropped folder) so the
        // terminal respawns there. TerminalPanel reads panel.cwd directly. The
        // terminalCwds map below feeds the separate scrollback-restore path.
        cwd: sp?.workingDirectory,
      }
      if (sp?.workingDirectory) terminalCwds[id] = sp.workingDirectory
    }
  }
  const pendingLocalPanels = Object.entries(sess?.localPanels ?? {})
  const acceptedLocalPanelIds = new Set<string>()
  let acceptedAny = true
  while (acceptedAny) {
    acceptedAny = false
    for (const [id, localPanel] of pendingLocalPanels) {
      if (acceptedLocalPanelIds.has(id) || panels?.[id] || ws.panels?.[id]) continue
      const child = localPanel.hermesSubagent
      if (
        localPanel.type !== 'hermes-subagent' || !child ||
        !panels?.[child.parentPanelId]
      ) continue
      ;(panels ??= {})[id] = {
        ...localPanel,
        hermesSubagent: restoredHermesSubagent(child),
      }
      acceptedLocalPanelIds.add(id)
      acceptedAny = true
    }
  }
  const rejectedLocalPanelIds = new Set(
    pendingLocalPanels.map(([id]) => id).filter((id) => !acceptedLocalPanelIds.has(id)),
  )

  return {
    workspaceId: sess?.workspaceId,
    workspaceName: ws.name,
    rootPath,
    dockState: pruneDockState(ws.dockState, removed),
    panels,
    panelRelations: sess?.panelRelations?.filter((relation) =>
      Boolean(panels?.[relation.fromPanelId] && panels?.[relation.toPanelId])),
    // Canvas geometry combines shareable nodes with machine-local generated nodes.
    canvases: (() => {
      const ids = new Set([...Object.keys(ws.canvases ?? {}), ...Object.keys(sess?.localCanvases ?? {})])
      if (!ids.size) return undefined
      return Object.fromEntries([...ids].map((id) => {
        const shared = ws.canvases?.[id]
        const local = sess?.localCanvases?.[id]
        const base = shared ?? local!
        return [id, {
          ...base,
          canvasNodes: {
            ...pruneCanvasNodes(local?.canvasNodes ?? {}, new Set([
              ...rejectedLocalPanelIds,
              ...Object.keys(shared?.canvasNodes ?? {}),
            ])),
            ...pruneCanvasNodes(shared?.canvasNodes ?? {}, removed),
          },
        }]
      }))
    })(),
    terminalCwds: Object.keys(terminalCwds).length ? terminalCwds : undefined,
    // Restore the persisted worktree registry (absolute paths) so colors/labels
    // are stable and panel.worktreeId references resolve after restart.
    worktrees: sess?.worktrees,
    worktreeViewScopes: restoredRepositoryScopes(sess),
    // Restore the machine-local reconnect info (absent ⇒ local). Only the
    // local-disk path carries it here; remote workspaces come straight from the
    // remoteProjects store with their connection already on the snapshot.
    connection: sess?.connection,
  }
}

/** Collect all panel IDs referenced in a WindowDockState layout tree. */
export function collectPanelIdsFromDockState(zones: WindowDockState): string[] {
  const ids = new Set<string>()
  for (const zone of Object.values(zones)) {
    for (const id of collectPanelIds(zone.layout)) ids.add(id)
  }
  return [...ids]
}

/** Move retired panel drafts into the repository overlay before pruning layouts. */
function restoredRepositoryScopes(session: ProjectSessionFile | null) {
  const panels = [...Object.values(session?.panels ?? {}), ...(session?.dockWindows ?? []).flatMap(window => Object.values(window.panels))]
  const legacy = panels.flatMap(panel => Object.entries(panel.sourceControlState ?? {}))
  if (!legacy.length) return session?.worktreeViewScopes
  const drafts: Record<string, string> = {}
  const scopes: Record<string, string> = {}
  for (const [root, state] of legacy) {
    if (state.worktreeId) scopes[root] = state.worktreeId
    const checkout = session?.worktrees?.find(worktree => worktree.id === state.worktreeId)?.path ?? root
    if (state.commitMessage) drafts[checkout] = state.commitMessage
  }
  return {
    ...session?.worktreeViewScopes,
    sourceControlDrafts: { ...drafts, ...session?.worktreeViewScopes?.sourceControlDrafts },
    sourceControlWorktreeByRepository: { ...scopes, ...session?.worktreeViewScopes?.sourceControlWorktreeByRepository },
  }
}
