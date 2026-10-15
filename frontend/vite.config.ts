import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // Запросы /api из браузера уходят на бэкенд (uvicorn на 8010)
    proxy: { '/api': 'http://127.0.0.1:8010' },
  },
  build: { chunkSizeWarningLimit: 2000 },
})
