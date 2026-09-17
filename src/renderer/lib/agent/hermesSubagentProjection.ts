import type { AgentHookEvent } from '../../../shared/agentHooks'
import { isHermesSubagentEvent } from '../../../shared/hermesSubagentEvents'
import { mergeHermesSubagentEvent } from '../../../shared/hermesSubagents'
import { useAppStore } from '../../stores/appStore'
import { placementForBackgroundPanel } from '../workspace/canvasAccess'

const MAX_HERMES_SUBAGENT_PANELS_PER_ROOT = 64

export interface HermesSubagentParent {
  workspaceId: string
  panelId: string
}

export type ResolveHermesSubagentParent = (
  terminalId: string,
) => HermesSubagentParent | null

export function markHermesSubagentsUnavailable(
  parentTerminalId: string,
  sourcePid?: number,
  sourceStartedAt?: string,
): void {
  useAppStore.setState((state) => ({
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      panels: Object.fromEntries(Object.entries(workspace.panels).map(([id, panel]) => {
        const child = panel.hermesSubagent
        if (
          !child || child.status !== 'running' || child.parentTerminalId !== parentTerminalId ||
          (sourcePid !== undefined && child.sourcePid !== sourcePid) ||
          (sourceStartedAt !== undefined && child.sourceStartedAt !== sourceStartedAt)
        ) return [id, panel]
        return [id, { ...panel, hermesSubagent: { ...child, status: 'unavailable', updatedAt: Date.now() } }]
      })),
    })),
  }))
}

/** Project one authenticated Hermes child lifecycle event into this window. */
export function ingestHermesSubagentEvent(
  event: AgentHookEvent,
  resolveParent: ResolveHermesSubagentParent,
  now = Date.now(),
): string | null {
  if (!isHermesSubagentEvent(event)) return null
  const parent = resolveParent(event.terminalId)
  if (!parent) return null
  const rootSessionId = event.sessionId
  const app = useAppStore.getState()
  const workspace = app.workspaces.find((candidate) => candidate.id === parent.workspaceId)
  if (!workspace?.panels[parent.panelId]) return null
  const logicalParentPanelId = event.subagent.parentSubagentId
    ? Object.values(workspace.panels).find(
        (panel) => {
          const child = panel.hermesSubagent
          return !!child && child.id === event.subagent.parentSubagentId &&
            child.parentTerminalId === event.terminalId &&
            child.rootSessionId === rootSessionId &&
            child.sourcePid === event.sourcePid &&
            child.sourceStartedAt === event.sourceStartedAt
        },
      )?.id ?? parent.panelId
    : parent.panelId
  const existing = Object.values(workspace.panels).find(
    (panel) =>
      panel.hermesSubagent?.id === event.subagent.id &&
      panel.hermesSubagent.parentTerminalId === event.terminalId &&
      panel.hermesSubagent.rootSessionId === rootSessionId &&
      panel.hermesSubagent.parentSessionId === event.subagent.parentSessionId &&
      panel.hermesSubagent.sourcePid === event.sourcePid &&
      panel.hermesSubagent.sourceStartedAt === event.sourceStartedAt &&
      panel.hermesSubagent.parentPanelId === logicalParentPanelId,
  )
  if (!existing) {
    const childCount = Object.values(workspace.panels).filter(
      (panel) =>
        panel.hermesSubagent?.parentTerminalId === event.terminalId &&
        panel.hermesSubagent.rootSessionId === rootSessionId &&
        panel.hermesSubagent.sourcePid === event.sourcePid &&
        panel.hermesSubagent.sourceStartedAt === event.sourceStartedAt,
    ).length
    if (childCount >= MAX_HERMES_SUBAGENT_PANELS_PER_ROOT) return null
  }
  const snapshot = mergeHermesSubagentEvent(
    existing?.hermesSubagent,
    logicalParentPanelId,
    event,
    now,
  )
  const panelId = app.createHermesSubagent(
    parent.workspaceId,
    snapshot,
    placementForBackgroundPanel(parent.workspaceId, logicalParentPanelId),
  )
  return panelId
}
