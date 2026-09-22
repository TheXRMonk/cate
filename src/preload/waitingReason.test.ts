import { expect, it, vi } from 'vitest'
import { SHELL_AGENT_SCREEN_STATE } from '../shared/ipc-channels'
const h = vi.hoisted(() => ({ expose: vi.fn(), send: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: h.expose }, ipcRenderer: { send: h.send, on: h.on, removeListener: vi.fn() }, webUtils: {}, webFrame: {} }))
import './index'
const api = h.expose.mock.calls.find(([name]) => name === 'electronAPI')![1]
it('transports waiting reasons through the preload bridge in both directions', () => {
  api.shellReportAgentScreenState('pty', 'waitingForInput', 'question')
  expect(h.send).toHaveBeenLastCalledWith(SHELL_AGENT_SCREEN_STATE, 'pty', 'waitingForInput', 'question')
  const listener = vi.fn()
  api.onAgentScreenStateUpdate(listener)
  const forward = h.on.mock.calls.find(([channel]) => channel === SHELL_AGENT_SCREEN_STATE)![1]
  forward({}, 'pty', 'waitingForInput', 'question')
  expect(listener).toHaveBeenCalledWith('pty', 'waitingForInput', 'question')
})
