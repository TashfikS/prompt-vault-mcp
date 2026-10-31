import { useEffect, useState } from 'react'
import { getSharedDiff } from '../api'
import type { SharedDiffPayload } from '../types'
import { ThemeToggleButton } from '../theme'
import VisualDiffViewer from './VisualDiffViewer'
import { Logo } from './ui/Brand'

export default function SharedDiffPage({ shareId }: { shareId: string }) {
  const [data, setData] = useState<SharedDiffPayload | null>(null)
  const [error, setError] = useState('')
  const params = new URLSearchParams(window.location.search)
  const granularityParam = params.get('granularity')
  const modeParam = params.get('mode')

  useEffect(() => {
    getSharedDiff(shareId)
      .then(res => {
        if (granularityParam === 'word' || granularityParam === 'sentence') res.diff_granularity = granularityParam
        if (modeParam === 'split' || modeParam === 'inline') res.view_mode = modeParam
        setData(res)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load comparison.'))
  }, [shareId, granularityParam, modeParam])

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f6f7f9] text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-slate-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900 sm:px-8">
        <div className="mx-auto flex max-w-6xl xl:max-w-7xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <a
              href="/"
              aria-label="PromptHold home"
              className="group -m-1 rounded-lg p-1 text-left transition hover:opacity-80 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 cursor-pointer"
            >
              <Logo />
            </a>
            <span className="text-slate-300 dark:text-zinc-600">/</span>
            <span className="text-sm font-medium text-slate-500 dark:text-zinc-400">Shared comparison</span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggleButton />
            <a href="/" className="btn-secondary btn-sm">Open workspace</a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl xl:max-w-7xl px-5 py-8 sm:px-8">
        {error ? (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>
        ) : !data ? (
          <p className="text-center text-sm text-slate-500 dark:text-zinc-400">Loading saved comparison…</p>
        ) : (
          <>
            <div className="mb-6">
              <span className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">{data.prompt.group_name}</span>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-zinc-100 sm:text-3xl">{data.prompt.title}</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-zinc-400">Read-only comparison snapshot shared by a teammate.</p>
            </div>
            <VisualDiffViewer
              promptId={data.prompt.id}
              promptTitle={data.prompt.title}
              versions={[data.base_version, data.target_version]}
              initialBaseVersion={data.base_version.version_number}
              initialTargetVersion={data.target_version.version_number}
              initialGranularity={data.diff_granularity}
              initialViewMode={data.view_mode}
              readOnlyShareMode
            />
          </>
        )}
      </main>
    </div>
  )
}
