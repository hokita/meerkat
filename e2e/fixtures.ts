import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'
import { ALLOWED_METHODS } from '../src/server/herdr/allowlist.js'
import { fakeSnapshot, startFakeHerdr, type FakeHerdr } from '../test-support/fake-herdr.js'

export interface Meerkat {
  fake: FakeHerdr
  baseURL: string
}

interface Fixtures {
  meerkat: Meerkat
}

interface Options {
  initialSnapshot: unknown
}

const STARTUP_TIMEOUT_MS = 15_000
const KILL_AFTER_MS = 5_000
const MAIN_PATH = fileURLToPath(new URL('../dist/server/main.js', import.meta.url))

function readPort(): string {
  return process.env['MEERKAT_E2E_PORT'] ?? '43219'
}

function waitForStartup(child: ChildProcess, port: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`Meerkat did not start within ${STARTUP_TIMEOUT_MS} ms: ${output}`))
    }, STARTUP_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.includes(`Meerkat on http://localhost:${port}`)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(
        new Error(`Meerkat exited with code ${String(code)} before starting: ${output.trim()}`)
      )
    })
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS)
  await exited
  clearTimeout(timer)
}

export const test = base.extend<Fixtures & Options>({
  initialSnapshot: [fakeSnapshot({ agents: [] }), { option: true }],
  meerkat: async ({ initialSnapshot }, use) => {
    const fake = await startFakeHerdr({ snapshot: initialSnapshot })
    const port = readPort()
    const child = spawn(process.execPath, [MAIN_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('MEERKAT_'))
        ),
        MEERKAT_HERDR_SOCKET: fake.socketPath,
        MEERKAT_PORT: port,
      },
    })
    try {
      await waitForStartup(child, port)
      await use({ fake, baseURL: `http://localhost:${port}` })
      const rejected = fake.received
        .map((entry) => entry.method)
        .filter((m) => !ALLOWED_METHODS.has(m))
      expect(rejected).toEqual([])
    } finally {
      await stopChild(child)
      await fake.stop()
    }
  },
})

export { expect }
