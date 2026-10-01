import { sendOsNotification } from '../notifications/osNotificationSend'
import type { AgentWaitingReason, NotificationAction } from '../../../shared/types'

/** The one "agent needs you" OS notification, shared by every agent surface:
 *  terminal CLI agents (agentScreenDetector) and T3 panels (AgentSession).
 *  `permission` switches to the needs-permission variant and carries what the
 *  agent is blocked on. Callers gate on a real state transition. */
export function notifyAgentNeedsAttention(options: {
  agentName: string | null
  action: NotificationAction
  permission?: string
  waitingReason?: AgentWaitingReason
}): void {
  if (options.waitingReason === 'interrupted') return
  const displayName = options.agentName ?? 'Agent'
  sendOsNotification({
    title: options.waitingReason === 'question' ? `${displayName} has a question`
      : options.waitingReason === 'error' ? `${displayName} needs attention`
      : options.permission || options.waitingReason === 'approval' ? `${displayName} needs permission` : `${displayName} needs input`,
    body: options.permission ?? `${displayName} is waiting for your response.`,
    action: options.action,
  })
}
