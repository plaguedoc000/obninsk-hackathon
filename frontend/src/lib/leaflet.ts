import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'

// Импортируйте этот файл один раз (import '@/lib/leaflet') в компоненте с картой:
// подключает стили Leaflet и чинит стандартные маркеры, которые без этого не видны после сборки Vite
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl })
