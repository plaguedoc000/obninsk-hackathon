import { useState } from 'react'
import { Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, formatDate, STATUS_LABELS, type Issue, type IssueStatus } from '@/lib/api'

type Props = {
  issue: Issue
  onChange: (issue: Issue) => void
  onDelete: (id: number) => void
}

export function IssueCard({ issue, onChange, onDelete }: Props) {
  const [busy, setBusy] = useState<'ai' | 'status' | 'delete' | null>(null)

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(kind)
    try {
      await action()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{issue.title}</CardTitle>
        <CardDescription>
          {issue.category} · {formatDate(issue.created_at)}
        </CardDescription>
      </CardHeader>
      {(issue.description || issue.ai_comment) && (
        <CardContent className="space-y-3">
          {issue.description && <p>{issue.description}</p>}
          {issue.ai_comment && (
            <div className="flex gap-2 rounded-lg bg-primary/5 p-3 text-sm">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
              <p>{issue.ai_comment}</p>
            </div>
          )}
        </CardContent>
      )}
      <CardFooter className="flex-wrap gap-2 border-t py-3">
        <Select
          value={issue.status}
          disabled={busy !== null}
          onValueChange={(status) =>
            run('status', async () => onChange(await api.updateIssue(issue.id, { status: status as IssueStatus })))
          }
        >
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => run('ai', async () => onChange(await api.askAi(issue.id)))}
        >
          <Sparkles />
          {busy === 'ai' ? 'Думаю…' : 'Совет ИИ'}
        </Button>
        {issue.status === 'done' && <Badge variant="secondary">Закрыто</Badge>}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          aria-label="Удалить"
          disabled={busy !== null}
          onClick={() =>
            run('delete', async () => {
              await api.deleteIssue(issue.id)
              onDelete(issue.id)
            })
          }
        >
          <Trash2 />
        </Button>
      </CardFooter>
    </Card>
  )
}
