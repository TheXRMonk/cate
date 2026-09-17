import { useEffect, useState } from 'react'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'

const STATUS_LABELS = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unavailable: 'Unavailable after restart',
} as const

export default function HermesSubagentPanel({ workspaceId, panelId }: PanelProps) {
  const [now, setNow] = useState(() => Date.now())
  const snapshot = useAppStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)
      ?.panels[panelId]?.hermesSubagent,
  )
  const running = snapshot?.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])
  if (!snapshot) {
    return (
      <section className="flex h-full items-center justify-center bg-surface-1 p-4 text-xs text-muted">
        Unavailable after restart
      </section>
    )
  }
  const failed = snapshot.status === 'failed' || snapshot.status === 'interrupted' || snapshot.status === 'unavailable'
  const elapsedMs = snapshot.durationMs ?? Math.max(
    0,
    (running ? now : snapshot.updatedAt) - snapshot.createdAt,
  )
  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-1 text-primary" data-hermes-subagent-status={snapshot.status}>
      <header className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">Hermes subagent</div>
          <div className="truncate font-mono text-[10px] text-muted">{snapshot.id}</div>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${running
          ? 'border-amber-400/50 text-amber-300'
          : failed ? 'border-red-400/50 text-red-300' : 'border-emerald-400/50 text-emerald-300'}`}
        >
          {STATUS_LABELS[snapshot.status]}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-2 flex flex-wrap gap-2 text-[10px] text-muted">
          {snapshot.role ? <span>{snapshot.role}</span> : null}
          <span>{snapshot.model ?? 'Model unavailable'}</span>
          {snapshot.profile ? <span>profile {snapshot.profile}</span> : null}
          <span>{(elapsedMs / 1000).toFixed(1)}s</span>
        </div>
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Task</h2>
        <p className="whitespace-pre-wrap text-xs leading-5">{snapshot.goal ?? 'Delegated task'}</p>
        {snapshot.summary ? (
          <>
            <h2 className="mb-2 mt-5 text-[11px] font-medium uppercase tracking-wide text-muted">Result</h2>
            <p className="whitespace-pre-wrap text-xs leading-5">{snapshot.summary}</p>
          </>
        ) : running ? (
          <p className="mt-5 text-[11px] text-muted">{snapshot.latestActivity ?? 'Working in Hermes.'}</p>
        ) : null}
      </div>
    </section>
  )
}
