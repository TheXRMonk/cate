import { beforeEach, expect, it } from 'vitest'
import { useStatusStore } from './statusStore'

beforeEach(() => useStatusStore.setState({ workspaces: {} }))

it('stores reason-only updates and clears reasons outside waiting or when omitted', () => {
  const store = useStatusStore.getState()
  store.setAgentId('ws', 'pty', 'hermes')
  store.setAgentState('ws', 'pty', 'waitingForInput', 'approval')
  const terminal = () => useStatusStore.getState().workspaces.ws.terminals.pty
  expect(terminal().waitingReason).toBe('approval')
  store.setAgentState('ws', 'pty', 'waitingForInput', 'question')
  expect(terminal().waitingReason).toBe('question')
  store.setAgentState('ws', 'pty', 'running', 'error')
  expect(terminal().waitingReason).toBeUndefined()
  store.setAgentState('ws', 'pty', 'waitingForInput', 'response-complete')
  store.setAgentState('ws', 'pty', 'waitingForInput')
  expect(terminal().waitingReason).toBeUndefined()
  expect(terminal().agentId).toBe('hermes')
})
