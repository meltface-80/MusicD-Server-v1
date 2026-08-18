import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const VERSION = (() => {
  try { return readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim() }
  catch { return '0.0.0.0' }
})()

export default defineConfig({
  plugins: [react()],
  define: {
    __MUSICD_VERSION__: JSON.stringify(VERSION),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:32600',
      '/ws': { target: 'ws://localhost:32600', ws: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
