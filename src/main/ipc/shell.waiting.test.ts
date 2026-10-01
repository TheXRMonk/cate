import { beforeEach, expect, it, vi } from 'vitest'
import { SHELL_AGENT_SCREEN_STATE } from '../../shared/ipc-channels'
const h = vi.hoisted(() => ({ on: vi.fn(), broadcast: vi.fn() }))
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { on: h.on } }))
vi.mock('./terminal', () => ({ getTerminalIds: () => [], onTerminalSessionsChanged: vi.fn() }))
vi.mock('../windowRegistry', () => ({ broadcastToAll: h.broadcast, isAnyWindowFocused: () => true }))
vi.mock('./agentSessionStamps', () => ({ clearAgentSessionStamp: vi.fn(), dropAgentSessionStampState: vi.fn() }))
import { registerHandlers } from './shell'

beforeEach(() => { vi.clearAllMocks(); registerHandlers() })
function send(terminal: unknown, state: unknown, reason?: unknown) {
  h.on.mock.calls.find(([channel]) => channel === SHELL_AGENT_SCREEN_STATE)![1]({}, terminal, state, reason)
}
it.each(['approval', 'question', 'response-complete', 'interrupted', 'error'])('broadcasts %s reasons', (reason) => {
  send('pty', 'waitingForInput', reason)
  expect(h.broadcast).toHaveBeenCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'waitingForInput', reason)
})
it('accepts legacy messages and strips reasons outside waiting', () => {
  send('pty', 'waitingForInput')
  expect(h.broadcast).toHaveBeenLastCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'waitingForInput', undefined)
  send('pty', 'running', 'approval')
  expect(h.broadcast).toHaveBeenLastCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'running', undefined)
})
it.each([[null, 'running'], ['', 'running'], ['pty', 'bogus'], ['pty', 'waitingForInput', 'bogus'], ['pty', 'waitingForInput', {}]])('rejects invalid payload %j', (...args) => {
  send(args[0], args[1], args[2])
  expect(h.broadcast).not.toHaveBeenCalled()
})
