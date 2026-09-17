import type { AgentHookEvent, HermesSubagentEvent } from './agentHooks'
import type { PanelState } from './types'

export type HermesSubagentStatus = HermesSubagentEvent['status'] | 'unavailable'

/** Machine-local view of one in-process Hermes delegate_task child. */
export interface HermesSubagentSnapshot {
  id: string
  parentPanelId: string
  /** Root Hermes terminal id from the authenticated hook route. */
  parentTerminalId: string
  /** Root session that owns this child tree. */
  rootSessionId: string
  parentSessionId: string
  /** Root Hermes process incarnation; children never cross this boundary. */
  sourcePid?: number
  sourceStartedAt?: string
  parentTurnId?: string
  parentSubagentId?: string
  sessionId?: string
  profile?: string
  role?: string
  model?: string
  goal?: string
  status: HermesSubagentStatus
  summary?: string
  durationMs?: number
  latestActivity?: string
  sequence?: number
  createdAt: number
  updatedAt: number
}

export function mergeHermesSubagentEvent(
  previous: HermesSubagentSnapshot | undefined,
  parentPanelId: string,
  event: AgentHookEvent & { subagent: HermesSubagentEvent },
  now = Date.now(),
): HermesSubagentSnapshot {
  const child = event.subagent
  if (previous?.sequence !== undefined && child.sequence === undefined) return previous
  if (previous?.sequence !== undefined && child.sequence !== undefined && child.sequence <= previous.sequence) {
    return previous
  }
  if (previous && previous.status !== 'running') return previous
  const status = child.status
  return {
    ...previous,
    id: child.id,
    parentPanelId,
    parentTerminalId: event.terminalId,
    rootSessionId: event.sessionId ?? child.parentSessionId,
    parentSessionId: child.parentSessionId,
    sourcePid: event.sourcePid ?? previous?.sourcePid,
    sourceStartedAt: event.sourceStartedAt ?? previous?.sourceStartedAt,
    parentTurnId: child.parentTurnId ?? previous?.parentTurnId,
    parentSubagentId: child.parentSubagentId ?? previous?.parentSubagentId,
    sessionId: child.sessionId ?? previous?.sessionId,
    profile: event.profile ?? previous?.profile,
    role: child.role ?? previous?.role,
    model: child.model ?? previous?.model,
    goal: child.goal ?? previous?.goal,
    status,
    summary: child.summary ?? previous?.summary,
    durationMs: child.durationMs ?? previous?.durationMs,
    latestActivity: child.latestActivity ?? previous?.latestActivity,
    sequence: child.sequence ?? previous?.sequence,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

/** In-process children cannot survive a Hermes process restart. */
export function restoredHermesSubagent(
  snapshot: HermesSubagentSnapshot | undefined,
): HermesSubagentSnapshot | undefined {
  if (!snapshot || snapshot.status !== 'running') return snapshot
  return { ...snapshot, status: 'unavailable' }
}

/** Owner-bound child projections and their parent cannot move independently. */
export function isHermesSubagentWindowBound(
  panelId: string,
  panels: Record<string, PanelState>,
): boolean {
  if (panels[panelId]?.type === 'hermes-subagent') return true
  return Object.values(panels).some((panel) => panel.hermesSubagent?.parentPanelId === panelId)
}
