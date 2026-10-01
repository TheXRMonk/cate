import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useStatusStore } from '../stores/statusStore'
import { useAgentInfoByPanel } from './useAgentPanelInfo'

vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { panelIdForPty: () => 'panel' },
}))

it('updates subscribed panel information when only the waiting reason changes', () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useStatusStore.setState({ workspaces: {} })
  const store = useStatusStore.getState()
  store.setAgentId('ws', 'pty', 'hermes')
  store.setAgentPresent('ws', 'pty', true)
  store.setAgentState('ws', 'pty', 'waitingForInput', 'approval')
  const host = document.createElement('div')
  const root = createRoot(host)
  function Harness() {
    const info = useAgentInfoByPanel('ws').panel
    return <span>{info?.name}:{info?.waitingReason}</span>
  }
  try {
    act(() => root.render(<Harness />))
    expect(host.textContent).toContain(':approval')
    act(() => store.setAgentState('ws', 'pty', 'waitingForInput', 'question'))
    expect(host.textContent).toContain(':question')
  } finally {
    act(() => root.unmount())
  }
})
