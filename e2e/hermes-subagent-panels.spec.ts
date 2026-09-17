import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp, resetViewport, seedTerminal } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

test('Hermes child lifecycle creates a linked read-only panel', async () => {
  let app: ElectronApplication | undefined
  let page: Page
  try {
    ;({ electronApp: app, mainWindow: page } = await launchApp({ empty: true }))
    await openTrustedWorkspace(page, mkdtempSync(path.join(tmpdir(), 'cate-hermes-subagent-e2e-')))
    await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
    await page.waitForSelector('[data-canvas-panel-id]')
    await resetViewport(page)
    const nodeId = await seedTerminal(page, { x: 120, y: 120 })
    const parentPanelId = await page.evaluate((id) =>
      window.__cateE2E!.nodes().find((node) => node.id === id)!.panelId, nodeId)

    const base = {
      terminalId: parentPanelId,
      agentId: 'hermes' as const,
      sessionId: 'root-session',
      cwd: 'C:/work/project',
      profile: 'work',
      sourcePid: 42,
      sourceStartedAt: '100',
      raw: {},
    }
    const childPanelId = await page.evaluate(({ parentPanelId, base }) =>
      window.__cateE2E!.emitHermesSubagentEvent(parentPanelId, {
        ...base,
        kind: 'subagent-start',
        subagent: {
          id: 'sa-0-e2echild', sessionId: 'child-session', parentSessionId: 'root-session',
          role: 'leaf', model: 'gpt-test', goal: 'Inspect the renderer boundary',
          status: 'running', sequence: 1,
        },
      }), { parentPanelId, base })
    expect(childPanelId).not.toBeNull()
    await page.waitForSelector(`[data-hermes-subagent-status="running"]`)
    await expect(page.locator(`[data-node-id]`).filter({ has: page.locator('[data-hermes-subagent-status="running"]') }))
      .toContainText('Inspect the renderer boundary')
    await expect(page.locator('[data-panel-automatic-relation]')).toHaveText('Delegated task')

    await page.evaluate(({ parentPanelId, base }) => {
      window.__cateE2E!.emitHermesSubagentEvent(parentPanelId, {
        ...base,
        kind: 'subagent-progress',
        subagent: {
          id: 'sa-0-e2echild', sessionId: 'child-session', parentSessionId: 'root-session',
          status: 'running', latestActivity: 'Using terminal', sequence: 2,
        },
      })
    }, { parentPanelId, base })
    await expect(page.locator('[data-hermes-subagent-status="running"]')).toContainText('Using terminal')

    await page.evaluate(({ parentPanelId, base }) => {
      window.__cateE2E!.emitHermesSubagentEvent(parentPanelId, {
        ...base,
        kind: 'subagent-stop',
        subagent: {
          id: 'sa-0-e2echild', sessionId: 'child-session', parentSessionId: 'root-session',
          status: 'completed', summary: 'No blockers found.', durationMs: 1234, sequence: 3,
        },
      })
    }, { parentPanelId, base })
    await expect(page.locator('[data-hermes-subagent-status="completed"]')).toContainText('No blockers found.')

    expect(await page.evaluate((id) => window.__cateE2E!.detachPanel(id), childPanelId!)).toBe(false)
    expect(await page.evaluate(() => window.__cateE2E!.panels().filter((panel) => panel.type === 'hermes-subagent').length))
      .toBe(1)
  } finally {
    if (app) await closeApp(app)
  }
})
