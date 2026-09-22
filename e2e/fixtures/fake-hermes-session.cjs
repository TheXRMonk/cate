'use strict'
/* global process, require, URL, Buffer, setInterval */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const http = require('node:http')

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const endpoint = process.env.CATE_HOOK_ENDPOINT
const token = process.env.CATE_HOOK_TOKEN
const terminalId = process.env.CATE_TERMINAL_ID
const processStartedAt = process.hrtime.bigint().toString()
const logPath = process.env.FAKE_HERMES_LOG
const profile = flag('--profile') || 'default'
const resumedSessionId = flag('--resume')
const sessionId = resumedSessionId || `fake_${String(terminalId).replace(/[^A-Za-z0-9_-]/g, '_')}`

function post(hookEventName, extra = {}) {
  if (!endpoint || !token || !terminalId) return Promise.resolve()
  const body = JSON.stringify({
    agentId: 'hermes',
    terminalId,
    pid: process.pid,
    processStartedAt,
    payload: {
      hook_event_name: hookEventName,
      session_id: sessionId,
      cwd: process.cwd(),
      profile,
      platform: 'cli',
      turn_id: 'fixture-turn',
      ...extra,
    },
  })
  return new Promise((resolve) => {
    const url = new URL(endpoint)
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname || '/',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 1_000,
    }, (response) => {
      response.resume()
      response.once('end', resolve)
    })
    request.once('timeout', () => { request.destroy(); resolve() })
    request.once('error', resolve)
    request.end(body)
  })
}

let finishing = false
async function finish() {
  if (finishing) return
  finishing = true
  await post('on_session_finalize')
  process.exit(0)
}

void (async () => {
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify({
      phase: resumedSessionId ? 'resume' : 'start',
      pid: process.pid,
      terminalId,
      sessionId,
      profile,
      args,
    })}\n`)
  }
  await post('on_session_start')
  await post('pre_llm_call')
  process.stdout.write(`FAKE_HERMES_${resumedSessionId ? 'RESUMED' : 'READY'} ${sessionId}\r\n`)
  process.on('SIGTERM', () => { void finish() })
  process.on('SIGINT', () => { void finish() })
  process.stdin.setEncoding('utf8')
  let inputBuffer = ''
  process.stdin.on('data', (data) => {
    inputBuffer += data
    if (!/[\r\n]/.test(inputBuffer)) return
    const chunk = inputBuffer
    inputBuffer = ''
    if (chunk.includes('__CATE_E2E_EXIT__')) void finish()
    if (chunk.includes('__CATE_WAIT_APPROVAL__')) void post('cate_wait_started', { waiting_reason: 'approval' })
    if (chunk.includes('__CATE_WAIT_QUESTION__')) void post('cate_wait_started', { waiting_reason: 'question' })
    if (chunk.includes('__CATE_TURN_DONE__')) void post('on_session_end')
    if (chunk.includes('__CATE_TURN_INTERRUPTED__')) void post('on_session_end', { interrupted: true })
    if (chunk.includes('__CATE_TURN_ERROR__')) void post('on_session_end', { failed: true })
    if (chunk.includes('__CATE_TURN_RESUME__')) void post('pre_llm_call')
  })
  process.stdin.resume()
  setInterval(() => {}, 60_000).unref()
})()
