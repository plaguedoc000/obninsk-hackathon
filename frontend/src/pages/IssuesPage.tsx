import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { IssueCard } from '@/components/IssueCard'
import { IssueForm } from '@/components/IssueForm'
import { IssuesMap } from '@/components/IssuesMap'
import { Skeleton } from '@/components/ui/skeleton'
import { PROJECT_TAGLINE } from '@/config'
import { api, type Issue } from '@/lib/api'

export default function IssuesPage() {
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [picked, setPicked] = useState<[number, number] | null>(null)

  useEffect(() => {
    api.listIssues().then(setIssues).catch((err) => toast.error(err.message))
    api.categories().then(setCategories).catch((err) => toast.error(err.message))
  }, [])

  const replaceIssue = (updated: Issue) =>
    setIssues((list) => list?.map((i) => (i.id === updated.id ? updated : i)) ?? null)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{PROJECT_TAGLINE}</h1>
      <div className="grid items-start gap-6 lg:grid-cols-[360px_1fr]">
        <IssueForm
          categories={categories}
          picked={picked}
          onCreated={(issue) => {
            setIssues((list) => [issue, ...(list ?? [])])
            setPicked(null)
          }}
        />
        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
            <IssuesMap issues={issues ?? []} picked={picked} onPick={setPicked} />
          </div>
          {issues === null ? (
            <Skeleton className="h-32 w-full" />
          ) : issues.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">Обращений пока нет</p>
          ) : (
            issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                onChange={replaceIssue}
                onDelete={(id) => setIssues((list) => list?.filter((i) => i.id !== id) ?? null)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
