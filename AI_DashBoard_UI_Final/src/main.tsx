import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LoginGate } from './components/LoginGate'
// Typography uses the OS system font (SF Pro on Apple, Segoe UI on Windows,
// Roboto on Android). No webfont download needed.
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

createRoot(rootEl).render(
  <StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </StrictMode>
)
