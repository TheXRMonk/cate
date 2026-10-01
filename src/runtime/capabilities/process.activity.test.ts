import { afterEach, describe, expect, it, vi } from 'vitest'
import { activityForPid, createProcessCapability } from './process'
import { snapshotProcessTreeWindows } from './windowsProcessTree'
import type { ProcTree } from './procfs'

vi.mock('./windowsProcessTree', () => ({ snapshotProcessTreeWindows: vi.fn() }))
vi.mock('node-pty', () => ({
  spawn: () => ({ pid: 10, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }),
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function tree(entries: Array<[pid: number, ppid: number, name: string]>): ProcTree {
  const nameByPid = new Map<number, string>()
  const childrenByPid = new Map<number, number[]>()
  for (const [pid, ppid, name] of entries) {
    nameByPid.set(pid, name)
    const children = childrenByPid.get(ppid)
    if (children) children.push(pid)
    else childrenByPid.set(ppid, [pid])
  }
  return { nameByPid, childrenByPid }
}

describe('terminal process activity', () => {
  it('keeps idle suspension disabled on Windows', async () => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }))
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const capability = createProcessCapability({
      resolveShell: () => ({ path: 'pwsh.exe', args: [] }),
      getEnv: () => ({}),
      idleSuspend: true,
    })
    await capability.create({ id: 'windows-pty', cols: 80, rows: 24, cwd: '' }, () => {}, () => {})
    capability.setIdleSuspend(true)
    capability.setVisibility('windows-pty', false)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('excludes suspended POSIX terminals from activity snapshots', async () => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'darwin' }))
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const capability = createProcessCapability({
      resolveShell: () => ({ path: 'bash', args: [] }),
      getEnv: () => ({}),
      idleSuspend: true,
    })
    await capability.create({ id: 'suspended-pty', cols: 80, rows: 24, cwd: '' }, () => {}, () => {})
    capability.setVisibility('suspended-pty', false)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(kill).toHaveBeenCalledWith(-10, 'SIGSTOP')
    expect(await capability.scanActivity(['suspended-pty'])).toEqual({})
    expect(snapshotProcessTreeWindows).not.toHaveBeenCalled()
    capability.setIdleSuspend(false)
  })

  it.each(['cmd', 'CMD.EXE', 'powershell', 'PowerShell.exe', 'pwsh', 'PWSH.EXE',
    'C:\\Windows\\System32\\cmd.exe', 'C:/Program Files/PowerShell/7/pwsh.exe',
    'bash.exe', 'zsh', 'bash', 'fish', 'sh', 'tcsh', 'ksh', 'dash',
  ])('does not report shell child %s as busy on Windows', (name) => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }))
    expect(activityForPid(10, tree([[20, 10, name]]))).toEqual({ type: 'idle' })
    expect(activityForPid(10, tree([[20, 10, name], [30, 10, 'node.exe']]))).toEqual({
      type: 'running', processName: 'node.exe',
    })
  })

  it('scans Windows activity and registered presence using the same snapshot', async () => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }))
    const processes = tree([[10, 1, 'pwsh.exe'], [20, 10, 'node.exe']])
    vi.mocked(snapshotProcessTreeWindows).mockResolvedValue(processes)
    const presenceFor = vi.fn(() => ({ agentId: 'codex' as const, agentPresent: true }))
    const capability = createProcessCapability({
      resolveShell: () => ({ path: 'pwsh.exe', args: [] }),
      getEnv: () => ({}),
      agentPresence: { presenceFor, drop: vi.fn() },
    })
    await capability.create({ id: 'windows-pty', cols: 80, rows: 24, cwd: '' }, () => {}, () => {})

    expect(await capability.scanActivity(['windows-pty', 'unknown'])).toEqual({
      'windows-pty': {
        activity: { type: 'running', processName: 'node.exe' },
        agentId: 'codex' as const, agentPresent: true,
      },
    })
    expect(snapshotProcessTreeWindows).toHaveBeenCalledTimes(1)
    expect(presenceFor).toHaveBeenCalledWith('windows-pty', processes)
    expect(await capability.scanActivity(['unknown'])).toEqual({})
    expect(await capability.scanPorts(['windows-pty'])).toEqual({})
    expect(snapshotProcessTreeWindows).toHaveBeenCalledTimes(1)
  })

  it('reports the direct foreground launcher without inferring agent identity', () => {
    const processes = tree([
      [10, 1, 'zsh'],
      [20, 10, 'npm exec grok'],
      [30, 20, 'node'],
      [40, 30, 'grok-0.1.2'],
    ])

    expect(activityForPid(10, processes)).toEqual({ type: 'running', processName: 'npm exec grok' })
  })

  it('does not treat an application\'s agent probes as terminal agents', () => {
    const processes = tree([
      [10, 1, 'zsh'],
      [20, 10, 'npm run dev'],
      [30, 20, 'node'],
      [40, 30, 'Electron'],
      [50, 40, 'claude'],
      [60, 40, 'codex'],
      [70, 40, 'opencode'],
    ])

    expect(activityForPid(10, processes)).toEqual({ type: 'running', processName: 'npm run dev' })
  })

  it('reports a directly launched agent as generic terminal activity', () => {
    const processes = tree([
      [10, 1, 'zsh'],
      [20, 10, 'codex'],
    ])

    expect(activityForPid(10, processes)).toEqual({ type: 'running', processName: 'codex' })
  })
})