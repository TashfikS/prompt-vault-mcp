import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FileText } from 'lucide-react'
import type { PromptItem } from '../types'

export default function PromptSelectDropdown({
  prompts,
  value,
  onChange,
}: {
  prompts: PromptItem[]
  value: string
  onChange: (promptId: string) => void
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

  const selected = prompts.find(p => p.id === value) ?? prompts[0]

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="field flex h-10 items-center py-0 justify-between gap-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
            <FileText size={13} />
          </span>
          <span className="truncate font-medium text-slate-900 dark:text-zinc-100">
            {selected?.title ?? 'Select a prompt'}
          </span>
          {selected && (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
              v{selected.current_version_number}
            </span>
          )}
        </div>
        <ChevronDown size={16} className={`shrink-0 text-slate-400 dark:text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-56 animate-pop-in overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
          <div className="px-2 py-1 text-[11px] font-medium text-slate-400 dark:text-zinc-500">
            Choose target prompt
          </div>
          <div className="space-y-1">
            {prompts.map(p => {
              const isSelected = p.id === selected?.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id)
                    setIsOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                    isSelected
                      ? 'bg-brand-50 text-brand-900 font-medium dark:bg-brand-950/60 dark:text-brand-200'
                      : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-slate-900 dark:text-zinc-100">{p.title}</span>
                      <span className="shrink-0 rounded-sm bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                        v{p.current_version_number}
                      </span>
                    </div>
                    {p.description && (
                      <p className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-zinc-500">
                        {p.description}
                      </p>
                    )}
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
