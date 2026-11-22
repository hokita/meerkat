import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { forgetReloadOnLoad } from './replyApi'
import './styles.css'

forgetReloadOnLoad()

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
