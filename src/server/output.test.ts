import { describe, expect, it } from 'vitest'
import { sanitizeOutput } from './output.js'

describe('sanitizeOutput', () => {
  it('strips CSI colour sequences', () => {
    expect(sanitizeOutput('\x1b[31mred\x1b[0m ok').text).toBe('red ok')
  })

  it('strips OSC terminated by BEL', () => {
    expect(sanitizeOutput('\x1b]0;title\x07after').text).toBe('after')
  })

  it('strips OSC 8 hyperlinks terminated by ST keeping visible text', () => {
    const input = '\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\'
    expect(sanitizeOutput(input).text).toBe('link')
  })

  it('strips C0, DEL and C1 controls', () => {
    expect(sanitizeOutput('a\x00b\x07c\x9bd').text).toBe('abcd')
    expect(sanitizeOutput('a\x7fb\rc').text).toBe('abc')
  })

  it('strips other two-byte escapes', () => {
    expect(sanitizeOutput('a\x1bMb').text).toBe('ab')
  })

  it('removes unterminated OSC and CSI at the end', () => {
    expect(sanitizeOutput('ok\x1b]0;never ends').text).toBe('ok')
    expect(sanitizeOutput('ok\x1b[31').text).toBe('ok')
  })

  it('keeps newlines, tabs and markup', () => {
    expect(sanitizeOutput('line1\n\tline2').text).toBe('line1\n\tline2')
    expect(sanitizeOutput('<script>alert(1)</script>').text).toBe('<script>alert(1)</script>')
  })

  it('clips large input from the start', () => {
    const input = `${'x'.repeat(100)}\n`.repeat(2000) + 'last line'
    const result = sanitizeOutput(input)
    expect(result.clipped).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536)
    expect(result.text.endsWith('last line')).toBe(true)
  })

  it('does not start with a replacement character when cutting an emoji', () => {
    for (let pad = 0; pad < 4; pad++) {
      const input = '😀'.repeat(50) + 'a'.repeat(pad)
      const result = sanitizeOutput(input, 61)
      expect(result.clipped).toBe(true)
      expect(result.text.startsWith('�')).toBe(false)
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(61)
    }
  })

  it('does not clip short input', () => {
    expect(sanitizeOutput('short')).toEqual({ text: 'short', clipped: false })
  })
})
