import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSmokeExit } from './smokeExit'

describe('createSmokeExit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fails at the default 3000ms deadline if cleanup never settles', async () => {
    const exit = vi.fn()
    const finish = createSmokeExit({ cleanup: () => new Promise(() => {}), exit })
    const pending = finish(0)
    await vi.advanceTimersByTimeAsync(2999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares completion and runs cleanup and exit only once', async () => {
    const cleanup = vi.fn(async () => {})
    const exit = vi.fn()
    const finish = createSmokeExit({ cleanup, exit })
    const first = finish(0)
    expect(finish(0)).toBe(first)
    await first
    expect(finish(0)).toBe(first)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a failure reported while cleanup is pending', async () => {
    const exit = vi.fn()
    const finish = createSmokeExit({ cleanup: async () => {}, exit })
    const pending = finish(0)
    finish(1)
    finish(0)
    await pending
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([0, 1])('exits 1 on cleanup rejection with assertion code %i', async (code) => {
    const exit = vi.fn()
    const finish = createSmokeExit({ cleanup: async () => { throw new Error('cleanup failed') }, exit })
    await finish(code)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves assertion failure after successful cleanup', async () => {
    const exit = vi.fn()
    await createSmokeExit({ cleanup: async () => {}, exit })(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores late cleanup rejection after a custom deadline', async () => {
    let rejectCleanup!: (error: Error) => void
    const cleanup = vi.fn(() => new Promise<void>((_, reject) => { rejectCleanup = reject }))
    const exit = vi.fn()
    const finish = createSmokeExit({ cleanup, exit, timeoutMs: 4000 })
    const pending = finish(1)
    await vi.advanceTimersByTimeAsync(3999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    rejectCleanup(new Error('late rejection'))
    await vi.runAllTimersAsync()
    expect(finish(0)).toBe(pending)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats synchronous cleanup throws as failure and clears the deadline', async () => {
    const exit = vi.fn()
    await createSmokeExit({ cleanup: () => { throw new Error('synchronous failure') }, exit })(0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('awaits successful cleanup before exiting with the assertion code', async () => {
    const cleanup = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 1500)))
    const exit = vi.fn()
    const finish = createSmokeExit({ cleanup, exit })
    const pending = finish(0)
    await vi.advanceTimersByTimeAsync(1499)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
