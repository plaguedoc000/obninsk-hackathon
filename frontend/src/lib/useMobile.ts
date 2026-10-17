import { useSyncExternalStore } from 'react'

// Телефон (и планшет стоя): экран уже 1024 px — до брейкпоинта lg. Там своя раскладка:
// фото на весь экран, инструменты внизу, лента миниатюр, жесты двумя пальцами
const QUERY = '(max-width: 1023.98px)'

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function useMobile() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false)
}
