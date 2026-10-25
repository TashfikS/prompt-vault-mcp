import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, Copy, LockKeyhole } from 'lucide-react'
import { diffArrays, diffWordsWithSpace } from 'diff'
import { api } from '../api'
import type { PromptVersionItem } from '../types'
import VersionSelectDropdown from './VersionSelectDropdown'
import { useToast } from './ui/Toast'

type Props = {
  promptId: string
  promptTitle: string
  versions: PromptVersionItem[]
  initialBaseVersion?: number
  initialTargetVersion?: number
  initialGranularity?: 'word' | 'sentence'
  initialViewMode?: 'split' | 'inline'
  readOnlyShareMode?: boolean
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallback
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

function diffSentenceChunks(oldText: string, newText: string): { value: string; added?: boolean; removed?: boolean }[] {
  const tokenize = (text: string): string[] => {
    if (!text) return []
    const tokens = text.match(/[^.!?\n]+([.!?]+(\s+|\n|$)|(\n+|$))/g)
    return tokens && tokens.length > 0 ? tokens : [text]
  }

  const partsA = tokenize(oldText)
  const partsB = tokenize(newText)
  return diffArrays(partsA, partsB).map(part => ({
    value: part.value.join(''),
    added: Boolean(part.added),
    removed: Boolean(part.removed),
  }))
}

export default function VisualDiffViewer({
  promptId,
  promptTitle,
  versions,
  initialBaseVersion,
  initialTargetVersion,
  initialGranularity = 'word',
  initialViewMode = 'split',
  readOnlyShareMode = false,
}: Props) {
  const notify = useToast()
  const sorted = [...versions].sort((a, b) => a.version_number - b.version_number)
  const newest = sorted[sorted.length - 1]?.version_number ?? 1
  const [baseNumber, setBaseNumber] = useState(initialBaseVersion ?? Math.max(1, newest - 1))
  const [targetNumber, setTargetNumber] = useState(initialTargetVersion ?? newest)
  const [granularity, setGranularity] = useState<'word' | 'sentence'>(initialGranularity)
  const [viewMode, setViewMode] = useState<'split' | 'inline'>(initialViewMode)
  const [copiedLink, setCopiedLink] = useState(false)

  useEffect(() => {
    if (sorted.length === 0) return
    if (!sorted.some(v => v.version_number === baseNumber)) {
      setBaseNumber(sorted[Math.max(0, sorted.length - 2)]?.version_number ?? sorted[0].version_number)
    }
    if (!sorted.some(v => v.version_number === targetNumber)) {
      setTargetNumber(sorted[sorted.length - 1]?.version_number ?? 1)
    }
  }, [sorted, baseNumber, targetNumber])

  const base = sorted.find(v => v.version_number === baseNumber) ?? sorted[0]
  const target = sorted.find(v => v.version_number === targetNumber) ?? sorted[sorted.length - 1]

  const changes = useMemo(() => {
    if (!base || !target) return []
    if (granularity === 'word') {
      return diffWordsWithSpace(base.content, target.content)
    }
    return diffSentenceChunks(base.content, target.content)
  }, [base, target, granularity])

  const added = useMemo(() => {
    const parts = changes.filter(part => part.added)
    if (granularity === 'word') {
      return parts.reduce((n, part) => n + Math.max(1, part.value.trim().split(/\s+/).filter(Boolean).length), 0)
    }
    return parts.length
  }, [changes, granularity])

  const removed = useMemo(() => {
    const parts = changes.filter(part => part.removed)
    if (granularity === 'word') {
      return parts.reduce((n, part) => n + Math.max(1, part.value.trim().split(/\s+/).filter(Boolean).length), 0)
    }
    return parts.length
  }, [changes, granularity])

  async function share() {
    try {
      const response = await api<{ share_id: string }>('/api/diff-shares', {
        method: 'POST',
        body: JSON.stringify({
          prompt_id: promptId,
          base_version: baseNumber,
          target_version: targetNumber,
          diff_granularity: granularity,
          view_mode: viewMode,
        }),
      })
      const link = `${window.location.origin}/?share_diff=${response.share_id}&base=${baseNumber}&target=${targetNumber}&granularity=${granularity}&mode=${viewMode}`
      await copyText(link)
      setCopiedLink(true)
      notify('Comparison link copied', { description: `Sharing v${baseNumber} → v${targetNumber} (${granularity}, ${viewMode})` })
      window.setTimeout(() => setCopiedLink(false), 2200)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not create a comparison link.', { tone: 'error' })
    }
  }

  return (
    <section className="card min-w-0 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">Compare versions</h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">Inspect exact additions and removals in “{promptTitle}”.</p>
        </div>
        {readOnlyShareMode && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
            <LockKeyhole size={13} /> Saved comparison
          </span>
        )}
      </div>

      {!readOnlyShareMode && (
        <div className="mt-4 flex flex-wrap items-stretch gap-2.5">
          {/* Box 1: Version Selection with PREVIOUS and CURRENT */}
          <div className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/80 p-1.5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="flex items-center gap-1.5">
              <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
                Base
              </span>
              <VersionSelectDropdown
                label="Previous Version"
                versions={sorted}
                selectedVersionNumber={baseNumber}
                onChange={setBaseNumber}
                hideLabel
              />
            </div>

            <ArrowRight size={14} className="mx-0.5 shrink-0 text-slate-400 dark:text-zinc-500" />

            <div className="flex items-center gap-1.5">
              <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/60 dark:text-emerald-300">
                Target
              </span>
              <VersionSelectDropdown
                label="Current Version"
                versions={sorted}
                selectedVersionNumber={targetNumber}
                onChange={setTargetNumber}
                hideLabel
              />
            </div>
          </div>

          {/* Box 2: Granularity toggle */}
          <div className="flex min-h-[48px] items-center rounded-xl border border-slate-200 bg-slate-50/80 p-1.5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="segmented h-full">
              {(['word', 'sentence'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setGranularity(value)}
                  className={`segmented-item flex h-full items-center ${
                    granularity === value ? 'segmented-item-active font-semibold text-brand-700 dark:text-brand-300' : ''
                  }`}
                >
                  {value === 'word' ? 'Word-by-word' : 'By sentence'}
                </button>
              ))}
            </div>
          </div>

          {/* Box 3: View Mode Toggle */}
          <div className="flex min-h-[48px] items-center rounded-xl border border-slate-200 bg-slate-50/80 p-1.5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900/80">
            <div className="segmented h-full">
              {(['split', 'inline'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setViewMode(value)}
                  className={`segmented-item flex h-full items-center ${
                    viewMode === value ? 'segmented-item-active font-semibold text-brand-700 dark:text-brand-300' : ''
                  }`}
                >
                  {value === 'split' ? 'Side-by-side' : 'Combined inline'}
                </button>
              ))}
            </div>
          </div>

          {/* Box 4: Share Button */}
          <button
            type="button"
            onClick={() => void share()}
            className="btn-secondary min-h-[48px] rounded-xl px-4 text-xs font-semibold"
          >
            {copiedLink ? <Check size={14} className="text-brand-600 dark:text-brand-400" /> : <Copy size={14} />}
            {copiedLink ? 'Link copied' : 'Share comparison'}
          </button>
        </div>
      )}

      {/* Difference counters */}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        {added > 0 && (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/60 dark:text-emerald-300">
            +{added} {granularity === 'word' ? (added === 1 ? 'word added' : 'words added') : (added === 1 ? 'sentence added' : 'sentences added')}
          </span>
        )}
        {removed > 0 && (
          <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 font-medium text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/60 dark:text-rose-300">
            −{removed} {granularity === 'word' ? (removed === 1 ? 'word removed' : 'words removed') : (removed === 1 ? 'sentence removed' : 'sentences removed')}
          </span>
        )}
        {added === 0 && removed === 0 && (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
            No changes between Version {baseNumber} and Version {targetNumber}
          </span>
        )}
      </div>

      {/* Diff display */}
      {viewMode === 'inline' ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/70">
          <p className="break-anywhere whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] font-mono text-xs leading-6 text-slate-800 dark:text-zinc-200">
            {changes.map((part, i) =>
              part.added ? (
                <span
                  key={i}
                  className="rounded bg-emerald-100 px-1 font-medium text-emerald-900 underline decoration-emerald-500 dark:bg-emerald-950/80 dark:text-emerald-200 dark:decoration-emerald-400"
                >
                  {part.value}
                </span>
              ) : part.removed ? (
                <span key={i} className="rounded bg-rose-100 px-1 text-rose-900 opacity-80 line-through dark:bg-rose-950/80 dark:text-rose-200">
                  {part.value}
                </span>
              ) : (
                <span key={i}>{part.value}</span>
              )
            )}
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <article className="min-w-0 overflow-hidden rounded-xl border border-rose-200/80 bg-rose-50/30 p-4 dark:border-rose-950/50 dark:bg-rose-950/20">
            <h4 className="mb-2.5 text-xs font-semibold text-rose-800 dark:text-rose-300">
              Version {baseNumber} · Base
            </h4>
            <p className="break-anywhere whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] font-mono text-xs leading-6 text-slate-800 dark:text-zinc-200">
              {changes.map((part, i) =>
                part.added ? null : part.removed ? (
                  <span key={i} className="rounded bg-rose-100 px-1 text-rose-900 line-through dark:bg-rose-950/80 dark:text-rose-200">
                    {part.value}
                  </span>
                ) : (
                  <span key={i}>{part.value}</span>
                )
              )}
            </p>
          </article>
          <article className="min-w-0 overflow-hidden rounded-xl border border-emerald-200/80 bg-emerald-50/30 p-4 dark:border-emerald-950/50 dark:bg-emerald-950/20">
            <h4 className="mb-2.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
              Version {targetNumber} · Target
            </h4>
            <p className="break-anywhere whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] font-mono text-xs leading-6 text-slate-800 dark:text-zinc-200">
              {changes.map((part, i) =>
                part.removed ? null : part.added ? (
                  <span key={i} className="rounded bg-emerald-100 px-1 font-medium text-emerald-900 dark:bg-emerald-950/80 dark:text-emerald-200">
                    {part.value}
                  </span>
                ) : (
                  <span key={i}>{part.value}</span>
                )
              )}
            </p>
          </article>
        </div>
      )}
    </section>
  )
}
