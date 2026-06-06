import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { initTheme } from './theme'
import './styles.css'

initTheme() // set the theme class before first paint (no flash)

const el = document.getElementById('root')
if (!el) throw new Error('Root element #root not found')
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
