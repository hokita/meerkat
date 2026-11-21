const ESC = 0x1b
const BEL = 0x07
const BACKSLASH = 0x5c

export interface SanitizedOutput {
  text: string
  clipped: boolean
}

function isKeptControl(code: number): boolean {
  return code === 0x0a || code === 0x09
}

function isDroppedControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

function skipOsc(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === BEL) return i + 1
    if (code === ESC && text.charCodeAt(i + 1) === BACKSLASH) return i + 2
  }
  return text.length
}

function skipCsi(text: string, from: number): number {
  let i = from
  while (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x3f) i += 1
  while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i += 1
  if (i < text.length && text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e) i += 1
  return i
}

function skipEscape(text: string, escIndex: number): number {
  const next = text.charCodeAt(escIndex + 1)
  if (next === 0x5d) return skipOsc(text, escIndex + 2)
  if (next === 0x5b) return skipCsi(text, escIndex + 2)
  if (next >= 0x20 && next <= 0x7e) return escIndex + 2
  return escIndex + 1
}

function strip(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === ESC) {
      i = skipEscape(text, i)
    } else if (isDroppedControl(code) && !isKeptControl(code)) {
      i += 1
    } else {
      out += text[i]
      i += 1
    }
  }
  return out
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

export function sanitizeOutput(text: string, maxBytes = 65536): SanitizedOutput {
  const stripped = strip(text)
  const bytes = Buffer.from(stripped, 'utf8')
  if (bytes.length <= maxBytes) {
    return { text: stripped, clipped: false }
  }
  let start = bytes.length - maxBytes
  while (start < bytes.length && isContinuationByte(bytes[start] ?? 0)) {
    start += 1
  }
  return { text: bytes.subarray(start).toString('utf8'), clipped: true }
}
