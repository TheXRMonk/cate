// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { win32 } from 'node:path'
import { execFile } from 'child_process'
import { snapshotProcessTree } from './process'
import { snapshotProcessTreeWindows } from './windowsProcessTree'

vi.mock('child_process', () => ({ execFile: vi.fn() }))

it('accepts the single-record JSON emitted for one process', async () => {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, '{"ProcessId":42,"ParentProcessId":1,"Name":"node.exe"}', '')
  }) as typeof execFile)
  const tree = await snapshotProcessTreeWindows()
  expect([...tree.nameByPid]).toEqual([[42, 'node']])
  expect([...tree.childrenByPid]).toEqual([[1, [42]]])
})

it.each([
  null, {}, { ProcessId: 0, ParentProcessId: 0, Name: 'bad' },
  { ProcessId: -1, ParentProcessId: 0, Name: 'bad' },
  { ProcessId: 1.5, ParentProcessId: 0, Name: 'bad' },
  { ProcessId: '1', ParentProcessId: 0, Name: 'bad' },
  { ProcessId: 1, ParentProcessId: -1, Name: 'bad' },
  { ProcessId: 1, ParentProcessId: 1.5, Name: 'bad' },
  { ProcessId: 1, ParentProcessId: '0', Name: 'bad' },
  { ProcessId: 1, ParentProcessId: 0, Name: 123 },
])('skips invalid CIM records: %j', async (invalid) => {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, JSON.stringify([invalid, { ProcessId: 42, ParentProcessId: 0, Name: 'valid' }]), '')
  }) as typeof execFile)
  const tree = await snapshotProcessTreeWindows()
  expect([...tree.nameByPid]).toEqual([[42, 'valid']])
  expect([...tree.childrenByPid]).toEqual([[0, [42]]])
})

it.each([
  { error: new Error('timeout'), stdout: '[{"ProcessId":42,"ParentProcessId":0,"Name":"node.exe"}]' },
  { error: null, stdout: '' },
  { error: null, stdout: 'not JSON' },
])('returns an empty snapshot on command or JSON failure: %j', async ({ error, stdout }) => {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(error, stdout, '')
  }) as typeof execFile)
  const tree = await snapshotProcessTreeWindows()
  expect(tree.nameByPid.size).toBe(0)
  expect(tree.childrenByPid.size).toBe(0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(execFile).mockReset()
})

it('snapshots native Windows PIDs using bounded absolute PowerShell, not Git Bash ps', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, JSON.stringify([
      { ProcessId: 100, ParentProcessId: 0, Name: 'bash.exe' },
      { ProcessId: 200, ParentProcessId: 100, Name: 'python.EXE' },
    ]), '')
  }) as typeof execFile)
  const tree = await snapshotProcessTree()
  expect([...tree.nameByPid]).toEqual([[100, 'bash'], [200, 'python']])
  expect([...tree.childrenByPid]).toEqual([[0, [100]], [100, [200]]])
  expect(execFile).toHaveBeenCalledWith(
    win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress'],
    { encoding: 'utf-8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    expect.any(Function),
  )
})