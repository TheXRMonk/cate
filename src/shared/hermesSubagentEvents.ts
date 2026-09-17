import type { AgentId } from './agents'

export interface HermesSubagentEvent {
  id: string
  sessionId?: string
  parentSessionId: string
  parentTurnId?: string
  parentSubagentId?: string
  role?: string
  model?: string
  goal?: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  summary?: string
  durationMs?: number
  latestActivity?: string
  sequence?: number
}

export interface HermesSubagentHookEvent {
  terminalId: string
  agentId: AgentId
  kind: 'subagent-start' | 'subagent-progress' | 'subagent-stop'
  sessionId: string | null
  cwd?: string
  profile: string
  sourcePid: number
  sourceStartedAt: string
  subagent: HermesSubagentEvent
  raw: Record<string, unknown>
}

const CHILD_ID = /^sa-[A-Za-z0-9_-]{1,124}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STATUSES = new Set(['running', 'completed', 'failed', 'interrupted'])

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

export function isHermesSubagentEvent(
  event: {
    kind: string
    agentId?: unknown
    terminalId?: unknown
    sessionId?: string | null
    profile?: unknown
    sourcePid?: unknown
    sourceStartedAt?: unknown
    subagent?: HermesSubagentEvent | null
  },
): event is HermesSubagentHookEvent {
  if (!(
    event.kind === 'subagent-start' ||
    event.kind === 'subagent-progress' ||
    event.kind === 'subagent-stop'
  )) return false
  const child = event.subagent
  const statusMatchesKind = event.kind === 'subagent-stop'
    ? child?.status === 'completed' || child?.status === 'failed' || child?.status === 'interrupted'
    : child?.status === 'running'
  return !!child &&
    event.agentId === 'hermes' &&
    typeof event.terminalId === 'string' && event.terminalId.length > 0 && event.terminalId.length <= 256 &&
    typeof event.sessionId === 'string' && SESSION_ID.test(event.sessionId) &&
    typeof event.profile === 'string' && event.profile !== 'custom' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(event.profile) &&
    typeof event.sourcePid === 'number' && Number.isInteger(event.sourcePid) && event.sourcePid > 0 &&
    typeof event.sourceStartedAt === 'string' && /^[0-9]{1,32}$/.test(event.sourceStartedAt) && /[1-9]/.test(event.sourceStartedAt) &&
    typeof child.id === 'string' && CHILD_ID.test(child.id) &&
    typeof child.parentSessionId === 'string' && SESSION_ID.test(child.parentSessionId) &&
    (child.sessionId === undefined || (typeof child.sessionId === 'string' && SESSION_ID.test(child.sessionId))) &&
    (child.parentSubagentId === undefined || (typeof child.parentSubagentId === 'string' && CHILD_ID.test(child.parentSubagentId))) &&
    statusMatchesKind && STATUSES.has(child.status) &&
    optionalBoundedString(child.parentTurnId, 128) &&
    optionalBoundedString(child.role, 32) &&
    optionalBoundedString(child.model, 128) &&
    optionalBoundedString(child.goal, 4_000) &&
    optionalBoundedString(child.summary, 12_000) &&
    optionalBoundedString(child.latestActivity, 96) &&
    (child.durationMs === undefined || (typeof child.durationMs === 'number' && Number.isFinite(child.durationMs) && child.durationMs >= 0 && child.durationMs <= 31_536_000_000)) &&
    typeof child.sequence === 'number' && Number.isSafeInteger(child.sequence) && child.sequence > 0
}