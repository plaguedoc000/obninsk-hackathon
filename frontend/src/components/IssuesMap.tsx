import { CircleMarker, MapContainer, Marker, Popup, TileLayer, useMapEvents } from 'react-leaflet'
import { MAP_CENTER } from '@/config'
import { STATUS_LABELS, type Issue, type IssueStatus } from '@/lib/api'

const STATUS_COLORS: Record<IssueStatus, string> = {
  new: '#ef4444',
  in_progress: '#f59e0b',
  done: '#22c55e',
}

type Point = [number, number]

function ClickHandler({ onPick }: { onPick: (point: Point) => void }) {
  useMapEvents({ click: (e) => onPick([e.latlng.lat, e.latlng.lng]) })
  return null
}

type Props = {
  issues: Issue[]
  picked?: Point | null
  onPick?: (point: Point) => void
}

export function IssuesMap({ issues, picked, onPick }: Props) {
  return (
    // isolate: иначе слои карты перекрывают выпадающие списки и шапку
    <MapContainer center={MAP_CENTER} zoom={13} scrollWheelZoom={false} className="isolate h-80 w-full lg:h-[440px]">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {onPick && <ClickHandler onPick={onPick} />}
      {issues
        .filter((issue) => issue.lat != null && issue.lng != null)
        .map((issue) => (
          <CircleMarker
            key={issue.id}
            center={[issue.lat!, issue.lng!]}
            radius={9}
            pathOptions={{ color: '#fff', weight: 2, fillColor: STATUS_COLORS[issue.status], fillOpacity: 0.9 }}
          >
            <Popup>
              <b>{issue.title}</b>
              <br />
              {issue.category} · {STATUS_LABELS[issue.status]}
            </Popup>
          </CircleMarker>
        ))}
      {picked && <Marker position={picked} />}
    </MapContainer>
  )
}
