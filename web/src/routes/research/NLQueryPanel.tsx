import { useState } from 'react'
import { Loader2, Send, FileCode, Sparkles, Download } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/domain/EmptyState'
import { useRunQuery } from '@/features/research/queries'
import { ApiError } from '@/lib/api/client'
import { toast } from '@/lib/utils/toast'

const SUGGESTIONS = [
  'Banks with RSI below 35 and positive YTD return',
  'Top 5 by volume today',
  'Symbols above their 50-day SMA with sentiment > 0.3',
  'Largest 5-day drawdowns this week',
] as const

export function NLQueryPanel() {
  const [question, setQuestion] = useState('')
  const run = useRunQuery()
  const result = run.data

  const submit = async (q?: string) => {
    const text = (q ?? question).trim()
    if (!text) return
    setQuestion(text)
    try {
      await run.mutateAsync(text)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Query failed')
    }
  }

  const exportCsv = () => {
    if (!result?.rows?.length) return
    const cols = result.columns ?? []
    const header = cols.join(',')
    const body = result.rows
      .map((row) =>
        row.map((cell) => {
          const s = cell == null ? '' : String(cell)
          return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        }).join(','),
      )
      .join('\n')
    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `query-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="size-4 text-accent" />
            Natural-language screen
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
            className="space-y-2"
          >
            <div className="relative">
              <textarea
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask in plain English — e.g. Banks with RSI below 35 and positive YTD return"
                className="block w-full resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-foreground-subtle">
                Cmd/Ctrl ↵ to run · Pro · 10 rpm
              </p>
              <Button type="submit" disabled={run.isPending || !question.trim()}>
                {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Run query
              </Button>
            </div>
          </form>

          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-foreground-subtle">Try one</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  disabled={run.isPending}
                  className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-foreground-muted transition-colors hover:border-border-strong hover:bg-surface-elevated hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {run.error && (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">
              {run.error instanceof ApiError ? run.error.message : 'Query failed'}
            </p>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border">
            <CardTitle className="text-sm">
              {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!result.rows.length}>
              <Download className="size-4" />
              Export CSV
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {result.rows.length === 0 ? (
              <EmptyState title="No matching rows" description="Try a broader question." className="m-4" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {(result.columns ?? []).map((c) => (
                      <TableHead key={c} className="capitalize">
                        {c.replace(/_/g, ' ')}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, i) => (
                    <TableRow key={i}>
                      {(row as unknown[]).map((cell, j) => (
                        <TableCell key={j} className={typeof cell === 'number' ? 'tabular' : ''}>
                          {formatCell(cell)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
          {result.generatedSQL && (
            <details className="border-t border-border bg-surface/50">
              <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-xs text-foreground-muted hover:text-foreground">
                <FileCode className="size-3.5" />
                View generated SQL
              </summary>
              <pre className="overflow-x-auto bg-background px-4 py-3 text-[11px] leading-snug text-foreground-muted">
                <code className="font-mono">{result.generatedSQL}</code>
              </pre>
            </details>
          )}
        </Card>
      )}
    </div>
  )
}

function formatCell(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toString()
    return v.toFixed(2)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
