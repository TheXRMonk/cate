import type { AgentWaitingReason } from '../../shared/types'
import type { HTMLAttributes, ReactNode } from 'react'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'

const AWAIT_COLOR = '#c08a5a'

interface AgentActivityTitleProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  running: boolean
  worktreeColor?: string
}

export function AgentActivityTitle({
  children,
  running,
  worktreeColor,
  className = '',
  ...props
}: AgentActivityTitleProps) {
  return (
    <span
      {...props}
      className={`${running ? 'cate-notif-pulse' : ''} ${className}`}
      style={worktreeTitleStyle(worktreeColor, running)}
    >
      {children}
    </span>
  )
}

const WAITING_LABELS: Record<AgentWaitingReason, string> = {
  approval: 'Awaiting approval',
  question: 'Awaiting answer',
  'response-complete': 'Response complete',
  interrupted: 'Interrupted',
  error: 'Agent error',
}

export function AwaitingIndicator({ className = '', waitingReason }: { className?: string; waitingReason?: AgentWaitingReason }) {
  const label = waitingReason ? WAITING_LABELS[waitingReason] : 'awaiting input'
  return (
    <span className={`cate-await-indicator shrink-0 ${className}`} aria-label={label} title={label}>
      <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
    </span>
  )
}
