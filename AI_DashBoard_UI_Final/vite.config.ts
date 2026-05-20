import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vite dev server runs on 11004. /api/* is proxied to NewAPI backend at 11002
// so the browser sees same-origin requests and the NewAPI session cookie
// (set when you log in at http://127.0.0.1:11002) is forwarded automatically.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 11004,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:11002',
        changeOrigin: false,
      },
    },
  },
})
