import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHerdrClient } from './herdr/client.js'
import { createReplySender } from './herdr/reply-sender.js'
import { createToken } from './guard.js'
import { createHttpServer, listen } from './http.js'
import { createSupervisor } from './supervisor.js'

export interface MeerkatConfig {
  port: number
  socketPath: string
  staticDir: string
}

const DEFAULT_PORT = 4321
const PLAIN_PORT = /^[1-9][0-9]{0,4}$/

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT
  const port = PLAIN_PORT.test(value) ? Number(value) : 0
  if (port < 1 || port > 65535) throw new Error(`Invalid MEERKAT_PORT: ${value}`)
  return port
}

export function readConfig(env: NodeJS.ProcessEnv, home: string): MeerkatConfig {
  return {
    port: parsePort(env.MEERKAT_PORT),
    socketPath: env.MEERKAT_HERDR_SOCKET ?? path.join(home, '.config', 'herdr', 'herdr.sock'),
    staticDir: fileURLToPath(new URL('../web', import.meta.url)),
  }
}

export async function run(env: NodeJS.ProcessEnv, home: string): Promise<void> {
  const config = readConfig(env, home)
  const client = createHerdrClient({ socketPath: config.socketPath })
  const supervisor = createSupervisor({ client, home })
  const server = createHttpServer({
    supervisor,
    client,
    sender: createReplySender({ socketPath: config.socketPath }),
    port: config.port,
    token: createToken(),
    staticDir: config.staticDir,
  })

  supervisor.start()
  try {
    await listen(server, config.port)
  } catch (error) {
    await supervisor.stop()
    throw error
  }
  console.log(`Meerkat on http://localhost:${config.port}`)

  const shutdown = async (): Promise<void> => {
    await supervisor.stop()
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

function isEntryModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(realpathSync(entry)).href
}

if (isEntryModule()) {
  run(process.env, os.homedir()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
