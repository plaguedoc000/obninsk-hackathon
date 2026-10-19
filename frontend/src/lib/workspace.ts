// Ключ этого браузера: по нему сервер отдаёт только свои фото (backend/app/workspace.py).
// Ключ живёт в localStorage и уходит на сервер в cookie — её браузер прикладывает и к картинкам <img src="/api/...">
const KEY = 'onescale-ws-key'
const COOKIE = 'onescale_ws'
const CLAIMED = 'onescale-ws-claimed'
const VALID = /^[A-Za-z0-9_-]{32,128}$/

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function storedKey() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

// Вызывается до первого запроса к API. Ключ уже выдал сервер (заходили в /api/docs) — берём его
export function ensureWorkspaceKey() {
  const fromCookie = document.cookie.match(/(?:^|;\s*)onescale_ws=([^;]+)/)?.[1]
  let key = storedKey() ?? fromCookie ?? null
  if (!key || !VALID.test(key)) key = randomKey()
  try {
    localStorage.setItem(KEY, key)
  } catch {
    // приватный режим: ключ проживёт, пока жива cookie
  }
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${COOKIE}=${key}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

// Фото, загруженные до появления ключей, лежат на сервере без владельца — забрать их нужно один раз
export function needsClaim() {
  try {
    return !localStorage.getItem(CLAIMED)
  } catch {
    return false
  }
}

export function markClaimed() {
  try {
    localStorage.setItem(CLAIMED, '1')
  } catch {
    // не запомнили — в следующий раз сервер просто ничего не отдаст
  }
}
