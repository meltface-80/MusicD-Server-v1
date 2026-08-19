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
      // v1.1.8.0 — was 32600, which is not a port anything listens on. The
      // server's default is 32700 (PORT in the Dockerfile, the docker run in
      // the README, and index.js's fallback), so `npm run dev` could never
      // reach the API.
      '/api': 'http://localhost:32700',
      '/ws': { target: 'ws://localhost:32700', ws: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // v1.1.8.0 — split the vendor libraries out of the app bundle.
        // Everything landed in one 606 kB chunk, which Rollup warned about
        // and which costs a phone the whole bundle again on every release.
        // React, the router, the store and the icon set change far less
        // often than app code, so separating them lets a browser keep them
        // cached across updates. Nothing is code-split by route here — this
        // is purely a caching boundary, so no behaviour changes.
        manualChunks: {
          react: ['react', 'react-dom'],
          icons: ['lucide-react'],
          store: ['zustand'],
        },
      },
    },
  }
})
