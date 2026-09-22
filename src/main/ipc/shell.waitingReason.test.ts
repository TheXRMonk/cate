import { describe, expect, it, vi } from 'vitest'
import { SHELL_AGENT_SCREEN_STATE } from '../../shared/ipc-channels'
const h = vi.hoisted(() => ({ on: vi.fn(), broadcast: vi.fn() }))
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { on: h.on } }))
vi.mock('../logger', () => ({ default: { warn: vi.fn() } }))
vi.mock('./terminal', () => ({ getRuntimeForTerminal: vi.fn(), getTerminalIds: () => [], getTerminalOwner: vi.fn(), onTerminalSessionsChanged: vi.fn() }))
vi.mock('../windowRegistry', () => ({ sendToWindow: vi.fn(), broadcastToAll: h.broadcast, isAnyWindowFocused: () => true }))
vi.mock('./agentSessionStamps', () => ({ clearAgentSessionStamp: vi.fn(), dropAgentSessionStampState: vi.fn() }))
import { registerHandlers } from './shell'
describe('agent screen state IPC', () => {
  it('validates and broadcasts optional waiting reasons', () => {
    registerHandlers()
    const handler = h.on.mock.calls.find(([channel]) => channel === SHELL_AGENT_SCREEN_STATE)![1]
    handler({}, 'pty', 'waitingForInput', 'question')
    expect(h.broadcast).toHaveBeenLastCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'waitingForInput', 'question')
    h.broadcast.mockClear()
    handler({}, 'pty', 'waitingForInput', 'invalid')
    handler({}, 'pty', 'invalid', 'question')
    handler({}, 123, 'waitingForInput', 'question')
    expect(h.broadcast).not.toHaveBeenCalled()
    handler({}, 'pty', 'running', 'approval')
    expect(h.broadcast).toHaveBeenLastCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'running', undefined)
    handler({}, 'pty', 'waitingForInput')
    expect(h.broadcast).toHaveBeenLastCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'waitingForInput', undefined)
  })
})
