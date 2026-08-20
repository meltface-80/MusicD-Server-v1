import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme, loadThemeId } from './theme'

// Applied before the first render, not from an effect inside App: an effect
// runs after paint, so the app would flash the default palette on every launch
// — most visibly for someone who chose a light theme.
applyTheme(loadThemeId())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
