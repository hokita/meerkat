import { useEffect, useState } from 'react'

export function formatElapsed(ms: number, lowerBound: boolean): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const prefix = lowerBound ? '≥ ' : ''
  if (seconds < 60) return `${prefix}${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${prefix}${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${prefix}${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
