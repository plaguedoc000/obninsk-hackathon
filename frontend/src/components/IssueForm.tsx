import { useState, type FormEvent } from 'react'
import { MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, type Issue } from '@/lib/api'

type Props = {
  categories: string[]
  picked: [number, number] | null
  onCreated: (issue: Issue) => void
}

export function IssueForm({ categories, picked, onCreated }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('Другое')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const issue = await api.createIssue({
        title,
        description,
        category,
        lat: picked?.[0] ?? null,
        lng: picked?.[1] ?? null,
      })
      onCreated(issue)
      setTitle('')
      setDescription('')
      toast.success('Обращение отправлено')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Новое обращение</CardTitle>
        <CardDescription>Кликните по карте, чтобы отметить место</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Что случилось</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например, яма у остановки"
              minLength={3}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Категория</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Подробности</Label>
            <Textarea
              id="description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="size-4" />
            {picked ? `${picked[0].toFixed(4)}, ${picked[1].toFixed(4)}` : 'Место не отмечено'}
          </p>
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? 'Отправляем…' : 'Отправить'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
