import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Откуда странице можно что-то грузить: только свой сайт и вход Флида ID (скрипт SDK и обмен кода на токены).
// Стили inline — для уведомлений sonner. Только в сборке: в разработке Vite вставляет свои inline-скрипты
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://id.flida.ru",
  "connect-src 'self' https://id.flida.ru",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  plugins: [react(), tailwindcss(), csp()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // Порт 3000: для него во Флида ID зарегистрирован адрес возврата после входа
    port: 3000,
    // Запросы /api из браузера уходят на бэкенд (uvicorn на 8010)
    proxy: { '/api': 'http://127.0.0.1:8010' },
  },
  build: { chunkSizeWarningLimit: 2000 },
})
