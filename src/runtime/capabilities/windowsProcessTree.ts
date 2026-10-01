import { execFile } from 'child_process'
import { win32 } from 'node:path'
import { countMonitorSpawn } from '../perf'
import type { ProcTree } from './procfs'

/** CIM reports native Windows PIDs, unlike the process table in Git Bash. */
export function snapshotProcessTreeWindows(): Promise<ProcTree> {
  return new Promise((resolve) => {
    const tree: ProcTree = { nameByPid: new Map(), childrenByPid: new Map() }
    const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    countMonitorSpawn('powershell')
    execFile(executable, [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress',
    ], { encoding: 'utf-8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(tree); return }
      let parsed: unknown
      try { parsed = JSON.parse(stdout) } catch { resolve(tree); return }
      for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!record || typeof record !== 'object'
          || !Number.isSafeInteger(record.ProcessId) || record.ProcessId <= 0
          || !Number.isSafeInteger(record.ParentProcessId) || record.ParentProcessId < 0
          || typeof record.Name !== 'string') continue
        tree.nameByPid.set(record.ProcessId, record.Name.replace(/\.exe$/i, ''))
        const siblings = tree.childrenByPid.get(record.ParentProcessId)
        if (siblings) siblings.push(record.ProcessId)
        else tree.childrenByPid.set(record.ParentProcessId, [record.ProcessId])
      }
      resolve(tree)
    })
  })
}