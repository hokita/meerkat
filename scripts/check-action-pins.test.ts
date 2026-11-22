import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHA = '11bd71901bbe5b1630ceea73d27597364c9af683'

const workflow = (uses: string) =>
  [
    'name: ci',
    'on: push',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${uses}`,
    '',
  ].join('\n')

describe('check-action-pins.sh', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'action-pins-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const run = () => spawnSync('scripts/check-action-pins.sh', [dir], { encoding: 'utf8' })

  it('passes when every uses is a full SHA', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow(`actions/checkout@${SHA}`))
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('All actions are pinned by SHA')
  })

  it('passes a quoted SHA pin', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow(`'actions/checkout@${SHA}'`))
    expect(run().status).toBe(0)
  })

  it('fails a tag pin and names the line', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow('actions/checkout@v4'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('ci.yml:7:')
  })

  it('fails a branch pin', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow('actions/checkout@main'))
    expect(run().status).toBe(1)
  })

  it('fails a short SHA', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow('actions/checkout@11d5960'))
    expect(run().status).toBe(1)
  })

  it('fails a SHA with a trailing comment', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow(`actions/checkout@${SHA} # v4`))
    expect(run().status).toBe(1)
  })

  it('scans .yaml files', () => {
    writeFileSync(join(dir, 'ci.yml'), workflow(`actions/checkout@${SHA}`))
    writeFileSync(join(dir, 'x.yaml'), workflow('actions/checkout@v4'))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('x.yaml:7:')
  })

  it('fails when the directory has no workflow files', () => {
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('no workflow files')
  })

  it('fails when the directory does not exist', () => {
    const result = spawnSync('scripts/check-action-pins.sh', [join(dir, 'missing')], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
  })

  it('fails when a workflow file cannot be read', () => {
    const file = join(dir, 'x.yml')
    writeFileSync(file, workflow('actions/checkout@v4'))
    chmodSync(file, 0o000)
    try {
      const result = run()
      expect(result.status).toBe(1)
      expect(result.stdout).not.toContain('All actions are pinned by SHA')
    } finally {
      chmodSync(file, 0o644)
    }
  })
})
