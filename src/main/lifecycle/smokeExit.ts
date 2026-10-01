interface SmokeExitOptions {
  cleanup: () => Promise<unknown>
  exit: (code: number) => void
  timeoutMs?: number
}

/** Smoke-only termination; deliberately independent of normal quit/session persistence. */
export function createSmokeExit({ cleanup, exit, timeoutMs = 3000 }: SmokeExitOptions): (code: number) => Promise<void> {
  let completion: Promise<void> | undefined
  let exitCode = 0

  return (code) => {
    // A later successful assertion must not erase a failure during cleanup.
    if (code !== 0) exitCode = code
    if (completion) return completion

    completion = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          // Defer invocation until completion is assigned, including reentrant calls.
          Promise.resolve().then(cleanup),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Smoke cleanup timed out')), timeoutMs)
          }),
        ])
      } catch {
        exitCode = 1
      } finally {
        clearTimeout(timer)
      }
      exit(exitCode)
    })()
    return completion
  }
}
