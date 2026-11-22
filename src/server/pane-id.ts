const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function paneIdFromSegment(segment: string): string | null {
  const decoded = decodeSegment(segment)
  return decoded !== null && PANE_ID.test(decoded) ? decoded : null
}
