import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root')

createRoot(container).render(
  <StrictMode>
    <h1>Meerkat</h1>
  </StrictMode>
)
