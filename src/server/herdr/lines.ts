import { StringDecoder } from 'node:string_decoder'

const MAX_LINE_BYTES = 8 * 1024 * 1024

export class LineTooLongError extends Error {
  constructor() {
    super(`Line exceeds ${MAX_LINE_BYTES} bytes`)
    this.name = 'LineTooLongError'
  }
}

export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''

  get pendingBytes(): number {
    return Buffer.byteLength(this.pending, 'utf8')
  }

  push(chunk: Buffer | string): string[] {
    const text = this.pending + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
    const parts = text.split('\n')
    this.pending = parts.pop() ?? ''
    if (this.pendingBytes > MAX_LINE_BYTES) {
      this.pending = ''
      throw new LineTooLongError()
    }
    const lines: string[] = []
    for (const part of parts) {
      const line = part.endsWith('\r') ? part.slice(0, -1) : part
      if (line.length === 0) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new LineTooLongError()
      lines.push(line)
    }
    return lines
  }
}
