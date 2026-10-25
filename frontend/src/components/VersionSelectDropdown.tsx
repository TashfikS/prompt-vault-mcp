import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, History } from 'lucide-react'
import type { PromptVersionItem } from '../types'

export default function VersionSelectDropdown({
  label = 'Version',
  versions,
  selectedVersionNumber,
  onChange,
  hideLabel = false,
}: {
  label?: string
  versions: PromptVersionItem[]
  selectedVersionNumber: number
  onChange: (versionNumber: number) => void
  hideLabel?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selected = versions.find(v => v.version_number === selectedVersionNumber) ?? versions[0]

  return (
    <div ref={wrapperRef} className="relative">
      {!hideLabel && (
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-zinc-400">
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex min-w-[200px] max-w-[260px] items-center justify-between gap-2.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-left text-sm text-slate-800 shadow-xs transition hover:border-slate-400 focus:border-brand-600 focus:ring-4 focus:ring-brand-600/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
            <History size={13} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-slate-900 dark:text-zinc-100">
                {selected?.change_note || `Version ${selected?.version_number}`}
              </span>
              <span className="shrink-0 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                v{selected?.version_number}
              </span>
            </div>
            <p className="truncate text-[11px] text-slate-400 dark:text-zinc-500">
              {selected?.author_name}
            </p>
          </div>
        </div>
        <ChevronDown size={15} className={`shrink-0 text-slate-400 dark:text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-30 mt-1.5 max-h-64 w-72 animate-pop-in overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
          <div className="px-2 py-1 text-[11px] font-medium text-slate-400 dark:text-zinc-500">
            Select {label.toLowerCase()}
          </div>
          <div className="space-y-1">
            {versions.map(v => {
              const isSelected = v.version_number === selected?.version_number
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    onChange(v.version_number)
                    setIsOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                    isSelected
                      ? 'bg-brand-50 text-brand-900 font-medium dark:bg-brand-950/60 dark:text-brand-200'
                      : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-semibold text-slate-900 dark:text-zinc-100">
                        {v.change_note}
                      </span>
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                        v{v.version_number}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-zinc-500">
                      {v.author_name} · {new Date(v.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  {isSelected && <Check size={15} className="shrink-0 text-brand-600 dark:text-brand-400" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
