import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HERMES_PLUGIN_MANIFEST, HERMES_PLUGIN_SOURCE } from './hermesIntegration'

// Execute the generated Python, not a TypeScript copy of its state machine.
// Windows commonly exposes Python as `python`, not `python3`.
const python = ['python3', 'python'].find(command =>
  spawnSync(command, ['--version'], { timeout: 5_000, windowsHide: true }).status === 0,
)

type Hook = { name: string; args?: Record<string, unknown> }
type Payload = Record<string, unknown>
type Step = { payloads: Payload[]; result: unknown }
const identity = { session_id: 'session-1', turn_id: 'turn-1', platform: 'cli' }
const hook = (name: string, args: Record<string, unknown> = {}): Hook => ({ name, args: { ...identity, ...args } })
const begin = hook('pre_llm_call')
const question = (id: string) => hook('pre_tool_call', { tool_name: 'clarify', tool_call_id: id, args: { question: 'Private question' } })
const approval = (id: string) => hook('pre_approval_request', { tool_call_id: id, surface: 'cli' })
const approved = (id: string) => hook('post_approval_response', { tool_call_id: id, surface: 'cli' })
const toolDone = (id: string) => hook('post_tool_call', { tool_name: 'clarify', tool_call_id: id, result: 'answer' })

function runHooks(sequence: Hook[]): Step[] {
  const output = execFileSync(python!, ['-c', `
import json, sys
source, sequence = json.load(sys.stdin)
ns = {}
exec(source, ns)
payloads = []
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return b"Cate context"
class Opener:
    def open(self, request, **kwargs):
        payloads.append(json.loads(request.data)["payload"])
        return Response()
ns["_connection"] = lambda: ("http://127.0.0.1:1", "test-token", "test-terminal")
ns["_OPENER"] = Opener()
callbacks = {}
class Ctx:
    profile_name = "default"
    def register_hook(self, name, callback): callbacks[name] = callback
ns["register"](Ctx())
payloads.clear()
steps = []
for step in sequence:
    # A missing registration is observable as absent output, not a harness crash.
    callback = callbacks.get(step["name"])
    result = callback(**step.get("args", {})) if callback else None
    steps.append({"payloads": list(payloads), "result": result})
    payloads.clear()
print(json.dumps(steps))
`], { input: JSON.stringify([HERMES_PLUGIN_SOURCE, sequence]), encoding: 'utf8', timeout: 10_000, windowsHide: true })
  return JSON.parse(output) as Step[]
}

function waits(step: Step): Payload[] {
  return step.payloads.filter(p => p.hook_event_name === 'cate_wait_started' || p.hook_event_name === 'cate_wait_resolved')
}

function expectWait(step: Step, event: 'started' | 'resolved', reason?: 'question' | 'approval'): void {
  expect(waits(step)).toContainEqual(expect.objectContaining({
    ...identity, hook_event_name: `cate_wait_${event}`,
    ...(event === 'started' ? { waiting_reason: reason } : {}),
  }))
}

// Resolution is global: no reason may resume Cate while any wait remains.
function expectNotResolved(step: Step): void {
  expect(waits(step)).not.toContainEqual(expect.objectContaining({
    hook_event_name: 'cate_wait_resolved',
  }))
}

describe('managed Hermes plugin waiting contract', () => {
  it('declares the clarify pre-tool lifecycle hook', () => {
    expect(HERMES_PLUGIN_MANIFEST).toContain('  - pre_tool_call')
  })

  describe.skipIf(!python)('registered Python callbacks', () => {
    it('keeps a question pending when a nested approval for the same tool resolves', () => {
      const steps = runHooks([begin, question('clarify-1'), approval('clarify-1'), approved('clarify-1'), toolDone('clarify-1')])
      expectWait(steps[1], 'started', 'question')
      expectWait(steps[2], 'started', 'approval')
      expectWait(steps[3], 'started', 'question')
      expectNotResolved(steps[2])
      expectNotResolved(steps[3])
      expectWait(steps[4], 'resolved')
    })

    it('does not resolve overlapping questions when only one tool completes', () => {
      const steps = runHooks([begin, question('a'), question('b'), toolDone('a'), toolDone('b')])
      expectWait(steps[1], 'started', 'question')
      expectNotResolved(steps[3])
      expectWait(steps[4], 'resolved')
    })

    it('does not resolve overlapping approvals when only one tool is approved', () => {
      const steps = runHooks([begin, approval('a'), approval('b'), approved('a'), approved('b')])
      expectWait(steps[1], 'started', 'approval')
      expectNotResolved(steps[3])
      expectWait(steps[4], 'resolved')
    })

    it('keeps the active turn wait across repeated pre_llm_call and returns context', () => {
      const steps = runHooks([begin, question('a'), begin, begin, toolDone('a')])
      expectWait(steps[1], 'started', 'question')
      for (const index of [2, 3]) {
        expectNotResolved(steps[index])
        expect(steps[index].result).toEqual({ context: 'Cate context' })
      }
      expectWait(steps[4], 'resolved')
    })

    it('ignores stale wait starts after turn completion, including after a new turn starts', () => {
      const steps = runHooks([
        begin, question('a'), hook('on_session_end', { completed: true }),
        question('late'), approval('late'),
        hook('pre_llm_call', { turn_id: 'turn-2' }),
        question('late-again'), approval('late-again'),
      ])
      expectWait(steps[1], 'started', 'question')
      for (const index of [3, 4, 6, 7]) expect(waits(steps[index])).toEqual([])
    })

    it.each(['on_session_start', 'on_session_reset'])('preserves the parent question across subagent %s', (name) => {
      const steps = runHooks([
        begin, question('parent-question'),
        hook(name, { session_id: 'child-session', turn_id: 'child-turn', platform: 'subagent' }),
        toolDone('parent-question'),
      ])
      expectWait(steps[1], 'started', 'question')
      expect(waits(steps[2])).toEqual([])
      expectWait(steps[3], 'resolved')
    })

    it('ignores subagent clarify even when its identity matches the active parent', () => {
      const steps = runHooks([
        begin,
        hook('pre_tool_call', { platform: 'subagent', tool_name: 'clarify', tool_call_id: 'child-question' }),
        question('parent-question'), toolDone('parent-question'),
      ])
      expect.soft(waits(steps[1])).toEqual([])
      expectWait(steps[3], 'resolved')
    })

    it('does not reactivate completed T1 on delayed pre_llm_call after T2 starts', () => {
      const steps = runHooks([
        begin, hook('on_session_end', { completed: true }),
        hook('pre_llm_call', { turn_id: 'turn-2' }),
        begin, question('stale-question'),
        hook('pre_tool_call', { turn_id: 'turn-2', tool_name: 'clarify', tool_call_id: 'current-question' }),
      ])
      expect.soft(waits(steps[4])).toEqual([])
      expect(waits(steps[5])).toContainEqual(expect.objectContaining({
        ...identity, turn_id: 'turn-2', hook_event_name: 'cate_wait_started', waiting_reason: 'question',
      }))
    })

    it('preserves pre_llm_call context and post_tool_call edit evidence without conversation leakage', () => {
      const evidence = {
        tool_name: 'patch', tool_call_id: 'edit-1', args: { path: 'src/example.ts', old_string: 'old', new_string: 'new' },
        result: 'patch applied', status: 'success', duration_ms: 12,
      }
      const steps = runHooks([
        hook('pre_llm_call', { messages: ['private conversation'], user_message: 'private prompt' }),
        hook('post_tool_call', evidence),
      ])
      expect(steps[0].result).toEqual({ context: 'Cate context' })
      expect(steps[1].payloads).toContainEqual(expect.objectContaining({
        ...identity, ...evidence, hook_event_name: 'post_tool_call',
      }))
      for (const step of steps) for (const payload of step.payloads) {
        expect(payload).not.toHaveProperty('messages')
        expect(payload).not.toHaveProperty('user_message')
      }
    })
  })
})
