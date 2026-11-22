import { describe, expect, it } from 'vitest'
import { readConfig } from './main.js'

describe('readConfig', () => {
  it('uses defaults', () => {
    const config = readConfig({}, '/Users/u')
    expect(config.port).toBe(4321)
    expect(config.socketPath).toBe('/Users/u/.config/herdr/herdr.sock')
    expect(config.staticDir.endsWith('/web')).toBe(true)
  })

  it('reads the port and socket from the environment', () => {
    const config = readConfig(
      { MEERKAT_PORT: '43219', MEERKAT_HERDR_SOCKET: '/tmp/x.sock' },
      '/Users/u'
    )
    expect(config.port).toBe(43219)
    expect(config.socketPath).toBe('/tmp/x.sock')
  })

  it.each(['abc', '0', '70000', '12.5', '+80', '0x50', '', ' 80', '080'])(
    'rejects MEERKAT_PORT=%j',
    (value) => {
      expect(() => readConfig({ MEERKAT_PORT: value }, '/Users/u')).toThrow(
        `Invalid MEERKAT_PORT: ${value}`
      )
    }
  )
})
