import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { closeApp, launchApp, resetViewport, seedTerminal } from './fixtures/electron-app'
import { openTrustedWorkspace } from './fixtures/workspace'

interface FakeLaunch {
  phase: 'start' | 'resume'
  pid: number
  terminalId: string
  sessionId: string
  profile: string
  cwd: string
  args: string[]
}

function fakeLaunches(logPath: string): FakeLaunch[] {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeLaunch)
  } catch {
    return []
  }
}

function stopFakeLaunches(entries: FakeLaunch[]): void {
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 'SIGTERM')
    } catch {
      // The PTY may already have terminated the fixture.
    }
  }
}

function killUserDataProcesses(userDataDir: string): void {
  if (process.platform !== 'win32') return
  const escaped = userDataDir.toLowerCase().replaceAll("'", "''")
  const script = [
    `$needle = '${escaped}';`,
    '$all = @(Get-CimInstance Win32_Process);',
    '$targets = @($all | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) });',
    '$ids = @($targets.ProcessId) + @($targets.ParentProcessId);',
    "$all | Where-Object { $ids -contains $_.ProcessId -and $_.ExecutablePath -and $_.ExecutablePath.ToLower().EndsWith('\\electron.exe') }",
    '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join(' ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    // Only stale Chromium helpers should remain after the Electron main process exits.
  }
}

async function closeTestApp(app: ElectronApplication, userDataDir: string): Promise<void> {
  const pid = app.process().pid
  await closeApp(app)
  if (process.platform === 'win32' && pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // A clean Electron shutdown removes the process before taskkill runs.
    }
    killUserDataProcesses(userDataDir)
  }
}

async function panelSessions(page: Page, ids: string[]) {
  return page.evaluate((panelIdsToRead) => {
    const panels = window.__cateE2E!.panels()
    return panelIdsToRead.map((id) => panels.find((panel) => panel.id === id)?.agentSession ?? null)
  }, ids)
}

test('two Hermes terminals cold-restore their own exact profile-scoped sessions', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-hermes-resume-e2e-')))
  const workspace = path.join(root, 'workspace')
  const userDataDir = path.join(root, 'userdata')
  const binDir = path.join(root, 'bin')
  const logPath = path.join(root, 'fake-hermes.jsonl')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  // Presence validates the hook sender's process name, not the launcher script.
  // Give the fixture a real Hermes-named process without changing production matchers.
  const runtimeDir = path.join(root, 'runtime')
  mkdirSync(runtimeDir)
  const fixtureRuntime = path.join(runtimeDir, process.platform === 'win32' ? 'hermes.exe' : 'hermes')
  copyFileSync(realpathSync(process.execPath), fixtureRuntime)
  chmodSync(fixtureRuntime, 0o755)
  const fixture = path.resolve(__dirname, 'fixtures', 'fake-hermes-session.cjs')
  const launcher = path.join(binDir, 'hermes')
  writeFileSync(launcher, `#!/bin/sh\nexec "${fixtureRuntime}" "${fixture}" "$@"\n`)
  chmodSync(launcher, 0o755)
  writeFileSync(
    path.join(binDir, 'hermes.cmd'),
    `@echo off\r\n"${fixtureRuntime}" "${fixture}" %*\r\n`,
  )

  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const env = {
    // Prefer Windows' bsdtar over Git-Bash tar: the latter parses `C:\\...`
    // archive paths as remote hosts during the E2E runtime bootstrap.
    PATH: `${binDir}${path.delimiter}${system32}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_HERMES_LOG: logPath,
  }
  let app: ElectronApplication | undefined
  let page: Page
  let passed = false

  try {
    ;({ electronApp: app, mainWindow: page } = await launchApp({ userDataDir, env, empty: true }))
    await openTrustedWorkspace(page, workspace)
    expect(await page.evaluate(() => window.__cateE2E!.setCodingAgentHookMode('hermes', 'on'))).toBe(true)
    await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
    await page.waitForSelector('[data-canvas-panel-id]')
    await resetViewport(page)

    const nodes: string[] = []
    for (const point of [{ x: 100, y: 100 }, { x: 800, y: 100 }]) {
      const node = await seedTerminal(page, point)
      await page.waitForFunction(
        (id) => !!window.__cateE2E!.terminalPtyId(id),
        node,
      )
      nodes.push(node)
    }
    const panels = await page.evaluate((ids) => {
      const liveNodes = window.__cateE2E!.nodes()
      return ids.map((id) => liveNodes.find((node) => node.id === id)!.panelId)
    }, nodes)
    const profiles = ['work', 'default'] as const

    for (const [index, node] of nodes.entries()) {
      await page.evaluate(
        ({ id, profile }) => window.__cateE2E!.writeTerminal(id, `hermes --profile ${profile}\r`),
        { id: node, profile: profiles[index] },
      )
    }
    for (const node of nodes) {
      await expect.poll(
        () => page.evaluate((id) => window.__cateE2E!.terminalText(id), node),
      ).toContain('FAKE_HERMES_READY')
    }

    await expect.poll(() => panelSessions(page, panels)).toEqual([
      expect.objectContaining({ agentId: 'hermes', profile: 'work', cwd: workspace }),
      expect.objectContaining({ agentId: 'hermes', profile: 'default', cwd: workspace }),
    ])
    const before = await panelSessions(page, panels)
    const sessionIds = before.map((session) => session!.sessionId)
    expect(new Set(sessionIds).size).toBe(2)

    // Drive each status through the authenticated PTY hook path; keep the
    // second pane working to prove a wait cannot bleed across terminals.
    const firstPane = page.locator(`[data-node-id="${nodes[0]}"]`)
    const secondPane = page.locator(`[data-node-id="${nodes[1]}"]`)
    for (const [command, label] of [
      ['__CATE_WAIT_APPROVAL__', 'Awaiting approval'],
      ['__CATE_WAIT_QUESTION__', 'Awaiting answer'],
      ['__CATE_TURN_DONE__', 'Response complete'],
      ['__CATE_TURN_INTERRUPTED__', 'Interrupted'],
      ['__CATE_TURN_ERROR__', 'Agent error'],
    ]) {
      await page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, `${command}\r`),
        { id: nodes[0], command })
      await expect(firstPane.getByLabel(label, { exact: true })).toBeVisible()
      await expect(secondPane.locator('.cate-await-indicator')).toHaveCount(0)
      // Resolve correlated waits without inventing a fresh LLM turn.
      const resume = command.startsWith('__CATE_WAIT_') ? '__CATE_WAIT_RESOLVED__' : '__CATE_TURN_RESUME__'
      await page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, `${command}\r`),
        { id: nodes[0], command: resume })
      await expect(firstPane.locator('.cate-await-indicator')).toHaveCount(0)
    }
    await page.evaluate((id) => window.__cateE2E!.writeTerminal(id, '__CATE_TURN_RESUME__\r'), nodes[0])
    await expect(firstPane.locator('.cate-await-indicator')).toHaveCount(0)

    // Poll durable state rather than assuming the autosave debounce has fired.
    await expect.poll(() => {
      try {
        const saved = JSON.parse(readFileSync(path.join(workspace, '.cate', 'session.json'), 'utf8'))
        return panels.map((id) => saved.panels[id]?.agentSession ?? null)
      } catch {
        return []
      }
    }, { timeout: 15_000 }).toEqual(before)
    await closeTestApp(app, userDataDir)
    app = undefined
    stopFakeLaunches(fakeLaunches(logPath).filter((entry) => entry.phase === 'start'))
    await new Promise((resolve) => setTimeout(resolve, 500))

    const savedSession = readFileSync(path.join(workspace, '.cate', 'session.json'), 'utf8')
    for (const sessionId of sessionIds) expect(savedSession).toContain(sessionId)
    for (const profile of profiles) expect(savedSession).toContain(`"profile": "${profile}"`)
    writeFileSync(path.join(root, 'first-session.json'), savedSession)
    writeFileSync(
      path.join(root, 'first-workspace.json'),
      readFileSync(path.join(workspace, '.cate', 'workspace.json'), 'utf8'),
    )

    ;({ electronApp: app, mainWindow: page } = await launchApp({ userDataDir, env, empty: true }))
    await page.waitForFunction(
      () => performance.getEntriesByName('session-restored').length > 0,
      undefined,
      { timeout: 30_000 },
    )
    for (const node of nodes) {
      await page.waitForSelector(`[data-node-id="${node}"]`, { timeout: 30_000 })
    }
    await resetViewport(page)
    for (const node of nodes) {
      await page.waitForFunction(
        (id) => !!window.__cateE2E!.terminalPtyId(id),
        node,
        { timeout: 30_000 },
      )
    }
    const restoredTerminalIds = await page.evaluate(
      (ids) => ids.map((id) => window.__cateE2E!.terminalPtyId(id)!),
      nodes,
    )
    for (const [index, node] of nodes.entries()) {
      await expect.poll(
        () => page.evaluate((id) => window.__cateE2E!.terminalText(id), node),
        { timeout: 30_000 },
      ).toContain(`FAKE_HERMES_RESUMED ${sessionIds[index]}`)
    }
    await expect.poll(
      () => fakeLaunches(logPath).filter((entry) => entry.phase === 'resume'),
      { timeout: 30_000 },
    ).toHaveLength(2)

    const resumed = fakeLaunches(logPath).filter((entry) => entry.phase === 'resume')
    for (const [index, terminalId] of restoredTerminalIds.entries()) {
      const entry = resumed.find((candidate) => candidate.terminalId === terminalId)
      expect(entry).toMatchObject({
        terminalId,
        sessionId: sessionIds[index],
        profile: profiles[index],
        cwd: workspace,
      })
      expect(entry?.args).toEqual([
        '--profile',
        profiles[index],
        'chat',
        '--resume',
        sessionIds[index],
      ])
    }
    await expect.poll(() => panelSessions(page, panels)).toEqual(before)
    stopFakeLaunches(resumed)
    await new Promise((resolve) => setTimeout(resolve, 500))
    passed = true
  } finally {
    if (app) await closeTestApp(app, userDataDir)
    stopFakeLaunches(fakeLaunches(logPath))
    if (passed) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      } catch (error) {
        console.warn(`Could not remove Hermes E2E fixture ${root}: ${String(error)}`)
      }
    } else {
      console.log(`Preserved failing Hermes E2E fixture at ${root}`)
    }
  }
})
