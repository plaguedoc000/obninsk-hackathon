import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ensureWorkspaceKey } from './lib/workspace'

// ключ браузера — до первого запроса к API
ensureWorkspaceKey()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
