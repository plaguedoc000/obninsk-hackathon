import { useEffect } from 'react'

// Презентация — готовая страница в public/pitch. Без слеша на конце сервер отдаёт приложение, поэтому переходим на /pitch/
export default function PitchRedirect() {
  useEffect(() => {
    window.location.replace('/pitch/' + window.location.hash)
  }, [])
  return null
}
