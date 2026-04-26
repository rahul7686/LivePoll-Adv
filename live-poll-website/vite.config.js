import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  resolve: {
    alias: {
      '@contract-client': fileURLToPath(
        new URL('./packages/live-poll-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: 'localhost',
    https: true,
    port: 5173,
  },
  preview: {
    host: 'localhost',
    https: true,
    port: 4173,
  },
})
