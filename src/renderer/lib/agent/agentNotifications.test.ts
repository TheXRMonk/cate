import { beforeEach, expect, it, vi } from 'vitest'
import { notifyAgentNeedsAttention } from './agentNotifications'
import { sendOsNotification } from '../notifications/osNotificationSend'
vi.mock('../notifications/osNotificationSend', () => ({ sendOsNotification: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
const base = { agentName: 'Hermes', action: { type: 'focusTerminal' as const, workspaceId: 'w', terminalId: 't' } }
it('uses question and error wording without claiming permission', () => {
  notifyAgentNeedsAttention({ ...base, waitingReason: 'question' })
  expect(sendOsNotification).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Hermes has a question' }))
  notifyAgentNeedsAttention({ ...base, waitingReason: 'error' })
  expect(sendOsNotification).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Hermes needs attention' }))
})
it('suppresses interruptions and preserves legacy permission wording', () => {
  notifyAgentNeedsAttention({ ...base, waitingReason: 'interrupted' })
  expect(sendOsNotification).not.toHaveBeenCalled()
  notifyAgentNeedsAttention({ ...base, permission: 'Run command' })
  expect(sendOsNotification).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Hermes needs permission', body: 'Run command' }))
})
