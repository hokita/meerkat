import { describe, expect, it } from 'vitest'
import { LineSplitter, LineTooLongError } from './lines.js'

describe('LineSplitter', () => {
  it('returns complete lines and buffers the remainder', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(splitter.push(':2}\n')).toEqual(['{"b":2}'])
    expect(splitter.pendingBytes).toBe(0)
  })

  it('joins a multi-byte character split across buffers', () => {
    const splitter = new LineSplitter()
    const bytes = Buffer.from('あい\n', 'utf8')
    expect(splitter.push(bytes.subarray(0, 4))).toEqual([])
    expect(splitter.push(bytes.subarray(4))).toEqual(['あい'])
  })

  it('trims CRLF endings', () => {
    expect(new LineSplitter().push('x\r\ny\r\n')).toEqual(['x', 'y'])
  })

  it('drops empty lines', () => {
    expect(new LineSplitter().push('\n\nx\n\r\n')).toEqual(['x'])
  })

  it('reports pending bytes', () => {
    const splitter = new LineSplitter()
    splitter.push('abc')
    expect(splitter.pendingBytes).toBe(3)
  })

  it('throws when a line exceeds 8 MiB without a newline', () => {
    const splitter = new LineSplitter()
    expect(() => splitter.push('a'.repeat(9 * 1024 * 1024))).toThrow(LineTooLongError)
  })
})
