import type { HerdrConnection } from '../shared/types'
import type { StreamState } from './useMeerkatStream'

interface BannersProps {
  herdr: HerdrConnection | null
  stream: StreamState
}

export function Banners({ herdr, stream }: BannersProps) {
  if (herdr !== 'disconnected' && stream !== 'lost') return null
  return (
    <div className="banners">
      {herdr === 'disconnected' && (
        <p className="banner" role="status">
          Herdr is not reachable — showing last known state
        </p>
      )}
      {stream === 'lost' && (
        <p className="banner" role="status">
          Meerkat server not reachable — retrying
        </p>
      )}
    </div>
  )
}
