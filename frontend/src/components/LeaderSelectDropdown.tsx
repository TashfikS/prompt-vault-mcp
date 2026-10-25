import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, UserCheck } from 'lucide-react'
import type { User } from '../types'

export default function LeaderSelectDropdown({
  users,
  value,
  onChange,
}: {
  users: User[]
  value: string
  onChange: (id: string) => void
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

  const selected = users.find(u => u.id === value)

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="field flex items-center justify-between gap-2.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
            <UserCheck size={12} />
          </span>
          <span className="truncate text-xs font-medium text-slate-800 dark:text-zinc-200">
            {selected ? `${selected.name} (${selected.email})` : 'Assign owner (defaults to you)'}
          </span>
        </div>
        <ChevronDown size={15} className={`shrink-0 text-slate-400 dark:text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-56 animate-pop-in overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop dark:border-zinc-800 dark:bg-zinc-900">
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => {
                onChange('')
                setIsOpen(false)
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                !value
                  ? 'bg-brand-50 text-brand-900 font-medium dark:bg-brand-950/60 dark:text-brand-200'
                  : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
              }`}
            >
              <span className="truncate">Assign owner (defaults to you)</span>
              {!value && <Check size={14} className="shrink-0 text-brand-600 dark:text-brand-400" />}
            </button>
            {users.map(u => {
              const isSelected = u.id === value
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    onChange(u.id)
                    setIsOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                    isSelected
                      ? 'bg-brand-50 text-brand-900 font-medium dark:bg-brand-950/60 dark:text-brand-200'
                      : 'text-slate-700 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-slate-900 dark:text-zinc-100">{u.name}</span>
                    <span className="block truncate text-[11px] text-slate-400 dark:text-zinc-500">{u.email}</span>
                  </div>
                  {isSelected && <Check size={14} className="shrink-0 text-brand-600 dark:text-brand-400" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
