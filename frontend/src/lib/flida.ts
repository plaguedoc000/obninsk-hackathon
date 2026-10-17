// Вход через Флида ID по Web SDK: https://docs.flida.ru/id/sdk/web
// «Войти» уводит на страницу Флиды, она возвращает на главную с ?code=…&state=…
// SDK сам делает PKCE и меняет код на токены, а сервер по access_token узнаёт у Флиды, кто вошёл
import { api, type AuthUser } from '@/lib/api'

type TokenResponse = { access_token: string; token_type: string }

type FlidaSDK = {
  authorize(): Promise<TokenResponse | undefined>
  autoAuthorization: Promise<TokenResponse | undefined>
}

type FlidaGlobal = {
  FlidaSDK: new (config: { clientId: string; redirectUri: string; fedcm: string[]; mode: 'redirect' | 'popup' }) => FlidaSDK
}

declare global {
  interface Window {
    Flida?: FlidaGlobal
  }
}

const SDK_URL = 'https://id.flida.ru/sdk/v1/sdk.js'

// Тот же адрес нужно добавить в консоли Флиды: Платформы → Web → Redirect URL
const redirectUri = () => `${window.location.origin}/`

let loading: Promise<FlidaGlobal> | null = null

// Скрипт Флиды грузим только когда нужен: по нажатию «Войти» или при возврате от Флиды
function loadSdk() {
  loading ??= new Promise<FlidaGlobal>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.onload = () => (window.Flida ? resolve(window.Flida) : reject(new Error('Скрипт Флида ID загрузился с ошибкой')))
    script.onerror = () => {
      loading = null
      script.remove()
      reject(new Error('Не удалось загрузить вход Флида ID. Проверьте интернет'))
    }
    document.head.append(script)
  })
  return loading
}

async function createSdk(clientId: string) {
  const { FlidaSDK } = await loadSdk()
  // Без FedCM: обычный переход на страницу Флиды работает во всех браузерах и на телефоне
  return new FlidaSDK({ clientId, redirectUri: redirectUri(), fedcm: [], mode: 'redirect' })
}

const MESSAGES: Record<string, string> = {
  invalid_config: 'Вход через Флида ID настроен неверно: проверьте FLIDA_CLIENT_ID и Redirect URL',
  invalid_state: 'Вход устарел или начат в другой вкладке. Нажмите «Войти» ещё раз',
  crypto_unavailable: 'Браузер не поддерживает безопасный вход. Откройте сайт по https',
  http_error: 'Флида ID не ответил. Попробуйте ещё раз',
  invalid_response: 'Флида ID ответил непонятно. Попробуйте ещё раз',
}

// Ошибки SDK приходят с кодом на английском — переводим. Ошибки нашего сервера уже по-русски
function readable(e: unknown) {
  if (e instanceof TypeError) return new Error('Нет связи с Флида ID. Проверьте интернет')
  if (!(e instanceof Error)) return new Error('Не удалось войти через Флида ID')
  if (e.name !== 'FlidaError') return e
  const code = (e as Error & { code: string }).code
  if (code === 'oauth_error') return new Error(e.message === 'access_denied' ? 'Вход через Флида ID отменён' : `Флида ID отказал во входе: ${e.message}`)
  return new Error(MESSAGES[code] ?? 'Не удалось войти через Флида ID')
}

// Флида вернула на сайт после входа (или отказа)
export function isFlidaCallback() {
  const q = new URLSearchParams(window.location.search)
  return window.location.pathname === '/' && q.has('state') && (q.has('code') || q.has('error'))
}

// Уходим на страницу Флиды. Обратно пользователь вернётся на главную, там сработает finishFlidaLogin
export async function startFlidaLogin(clientId: string) {
  try {
    await (await createSdk(clientId)).authorize()
  } catch (e) {
    throw readable(e)
  }
}

let finishing: Promise<AuthUser> | null = null

// Один раз на загрузку страницы: в StrictMode эффект запускается дважды, а код от Флиды одноразовый
export function finishFlidaLogin(clientId: string) {
  finishing ??= (async () => {
    try {
      const sdk = await createSdk(clientId)
      // SDK уже прочитал ответ — убираем code и state из адресной строки
      window.history.replaceState(window.history.state, '', window.location.pathname)
      const tokens = await sdk.autoAuthorization
      if (!tokens) throw new Error('Флида ID не вернул вход. Нажмите «Войти» ещё раз')
      return (await api.loginFlida(tokens.access_token)).user
    } catch (e) {
      throw readable(e)
    }
  })()
  return finishing
}
