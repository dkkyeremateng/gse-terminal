import { useCallback, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Loader2,
  Upload,
  X,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAdminUpload } from '@/features/admin/queries'
import type { IngestResult } from '@/features/admin/types'
import { cn } from '@/lib/utils/cn'

const EXPECTED_COLUMNS = [
  'Daily Date',
  'Share Code',
  'Year High',
  'Year Low',
  'Shares Traded',
  'Value Traded',
]

interface PreviewState {
  rows: number
  cols: number
  headers: string[]
  head: string[][]
}

export function IngestionTab() {
  const upload = useAdminUpload()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [result, setResult] = useState<IngestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(async (next: File | null) => {
    setFile(next)
    setResult(null)
    setError(null)
    setPreview(null)
    if (!next) return
    try {
      const text = await readFirstChunk(next, 256 * 1024)
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
      if (lines.length === 0) return
      const headers = parseCsvLine(lines[0])
      const head = lines.slice(1, 11).map(parseCsvLine)
      setPreview({ rows: lines.length - 1, cols: headers.length, headers, head })
    } catch {
      // Preview is best-effort; the upload itself still works without it.
    }
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) {
      if (inputRef.current) inputRef.current.value = ''
      handleFile(f)
    }
  }

  const onSubmit = async () => {
    if (!file) return
    setError(null)
    setResult(null)
    try {
      const res = await upload.mutateAsync(file)
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  const clear = () => {
    if (inputRef.current) inputRef.current.value = ''
    handleFile(null)
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="space-y-4">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4 text-foreground-muted" />
              Data ingestion
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <p className="text-xs text-foreground-muted">
              Upload a GSE daily trade CSV to synchronize with the live terminal.
            </p>

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={cn(
                'group flex w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-surface px-6 py-9 text-center transition-colors',
                'hover:border-primary/50 hover:bg-secondary/30',
                dragOver && 'border-primary bg-primary/5',
              )}
            >
              <span className="inline-flex size-11 items-center justify-center rounded-md border border-border bg-surface-elevated text-primary group-hover:scale-105 group-hover:shadow-sm">
                <Upload className="size-5" />
              </span>
              <span className="text-sm font-medium">
                {dragOver ? 'Drop the CSV to upload' : 'Drop CSV file here'}
              </span>
              <span className="text-[11px] text-foreground-subtle">or click to browse · .csv only</span>
            </button>

            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />

            {file && (
              <div className="space-y-3 rounded-md border border-border bg-surface p-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex size-8 items-center justify-center rounded border border-border bg-surface-elevated text-[9px] font-bold tracking-widest text-primary">
                    CSV
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={file.name}
                  >
                    {file.name}
                  </span>
                  <button
                    type="button"
                    onClick={clear}
                    aria-label="Remove file"
                    className="rounded p-1 text-foreground-subtle transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Rows" value={preview?.rows?.toLocaleString() ?? '—'} />
                  <Stat label="Size" value={formatSize(file.size)} />
                  <Stat label="Status" value={upload.isPending ? 'Uploading…' : 'Ready'} tone={upload.isPending ? 'accent' : 'gain'} />
                </div>
              </div>
            )}

            <Button onClick={onSubmit} disabled={!file || upload.isPending} className="w-full">
              {upload.isPending && <Loader2 className="size-4 animate-spin" />}
              Ingest dataset
            </Button>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-loss/30 bg-loss/10 p-3 text-sm text-loss">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {result && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-md border p-3 text-sm',
                  result.skipped > 0
                    ? 'border-accent/30 bg-accent/10 text-accent'
                    : 'border-gain/30 bg-gain/10 text-gain',
                )}
              >
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <span>
                  {result.skipped > 0
                    ? `Ingested ${result.inserted.toLocaleString()} rows · skipped ${result.skipped.toLocaleString()} malformed.`
                    : `Successfully ingested ${result.inserted.toLocaleString()} rows.`}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="text-sm">Expected columns</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-5 text-xs text-foreground-muted">
            {EXPECTED_COLUMNS.map((c) => (
              <div key={c} className="flex items-center gap-2">
                <span className="size-1 rounded-full bg-foreground-subtle" />
                {c}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileSpreadsheet className="size-4 text-foreground-muted" />
            Data frame
          </CardTitle>
          {preview && (
            <span className="text-[11px] tabular text-foreground-subtle">
              {preview.cols} cols · {preview.rows.toLocaleString()} rows
            </span>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {!file ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div
                aria-hidden
                className="size-28 rounded opacity-20"
                style={{
                  backgroundImage: 'radial-gradient(currentColor 1.5px, transparent 1.5px)',
                  backgroundSize: '14px 14px',
                  color: 'var(--foreground-subtle)',
                }}
              />
              <div>
                <p className="text-sm font-medium text-foreground-muted">No file selected</p>
                <p className="mt-1 max-w-48 text-[11px] text-foreground-subtle">
                  Select a CSV on the left to preview its first ten rows here.
                </p>
              </div>
            </div>
          ) : !preview ? (
            <div className="px-6 py-16 text-center text-sm text-foreground-muted">
              Reading preview…
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full caption-bottom text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border">
                    {preview.headers.map((h, i) => (
                      <th
                        key={i}
                        className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-foreground-subtle"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.head.map((row, ri) => (
                    <tr key={ri} className="border-b border-border last:border-0 even:bg-secondary/15">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-2 align-middle tabular text-foreground">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'gain' | 'loss' | 'accent'
}) {
  return (
    <div className="rounded border border-border bg-surface-elevated px-2.5 py-1.5">
      <p className="text-[9px] font-bold uppercase tracking-wider text-foreground-subtle">{label}</p>
      <p
        className={cn(
          'mt-0.5 truncate text-[12px] font-semibold tabular',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
          tone === 'accent' && 'text-accent',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function readFirstChunk(file: File, limit: number): Promise<string> {
  const slice = file.slice(0, Math.min(file.size, limit))
  return slice.text()
}

/**
 * Minimal CSV line parser — handles quoted cells with embedded commas and
 * doubled quotes. Doesn't try to match a full RFC 4180 implementation; the
 * preview only renders the first ~10 rows, so simplicity beats correctness
 * on edge cases.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else if (ch === '"') {
      inQuotes = true
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}
